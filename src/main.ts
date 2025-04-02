import { readFileSync, existsSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import path from "path";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const API_PROVIDER: string = core.getInput("API_PROVIDER") || "openai";
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL = core.getInput("OPENAI_API_MODEL");
const DEEPSEEK_API_KEY: string = core.getInput("DEEPSEEK_API_KEY");
const DEEPSEEK_API_MODEL = core.getInput("DEEPSEEK_API_MODEL");
const REVIEW_MODE: string = core.getInput("REVIEW_MODE") || "default";
const COMMIT_SHA: string = core.getInput("COMMIT_SHA") || "";
const BASE_SHA: string = core.getInput("BASE_SHA") || "";
const HEAD_SHA: string = core.getInput("HEAD_SHA") || "";
const PROMPT_PATH: string = core.getInput("PROMPT_PATH") || "";
// ALLOWED_USERS is no longer needed as permission checking is handled at the workflow level
// const ALLOWED_USERS: string[] = core.getInput("ALLOWED_USERS").split(",").map(u => u.trim());

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Initialize OpenAI client if using OpenAI
const openai = API_PROVIDER === "openai" 
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// For Deepseek API, we'll use fetch directly since there's no official SDK
// We'll implement the Deepseek API calls in the getAIResponse function

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  try {
    console.log("GITHUB_EVENT_PATH:", process.env.GITHUB_EVENT_PATH);
    const eventPath = process.env.GITHUB_EVENT_PATH || "";
    if (!eventPath) {
      throw new Error("GITHUB_EVENT_PATH environment variable is not set");
    }

    const eventData = JSON.parse(readFileSync(eventPath, "utf8"));
    console.log("Event type:", process.env.GITHUB_EVENT_NAME);
    
    if (process.env.GITHUB_EVENT_NAME === "issue_comment") {
      if (!eventData.issue || !eventData.issue.pull_request) {
        throw new Error("Comment is not on a pull request");
      }
      
      const prUrl = eventData.issue.pull_request.url;
      console.log("PR URL from comment:", prUrl);
      
      const urlParts = prUrl.split('/');
      const number = parseInt(urlParts[urlParts.length - 1], 10);
      const repo = urlParts[urlParts.length - 3];
      const owner = urlParts[urlParts.length - 4];
      
      console.log(`Extracted PR info - owner: ${owner}, repo: ${repo}, number: ${number}`);
      
      const prResponse = await octokit.pulls.get({
        owner,
        repo,
        pull_number: number,
      });
      
      return {
        owner,
        repo,
        pull_number: number,
        title: prResponse.data.title ?? "",
        description: prResponse.data.body ?? "",
      };
    }
    
    if (!eventData.repository || !eventData.repository.owner) {
      console.log("Event data:", JSON.stringify(eventData, null, 2));
      throw new Error("Invalid event data: missing repository information");
    }
    
    const repository = eventData.repository;
    const number = eventData.number || eventData.pull_request?.number;
    
    if (!number) {
      console.log("Event data:", JSON.stringify(eventData, null, 2));
      throw new Error("Invalid event data: missing pull request number");
    }
    
    console.log(`PR info - owner: ${repository.owner.login}, repo: ${repository.name}, number: ${number}`);
    
    const prResponse = await octokit.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
    });
    
    return {
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
      title: prResponse.data.title ?? "",
      description: prResponse.data.body ?? "",
    };
  } catch (error) {
    console.error("Error in getPRDetails:", error);
    if (error instanceof Error) {
      throw new Error(`Failed to get PR details: ${error.message}`);
    }
    throw new Error(`Failed to get PR details: ${String(error)}`);
  }
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];
  
  console.log(`Analyzing ${parsedDiff.length} files from diff:`);
  for (const file of parsedDiff) {
    console.log(`- File: ${file.to || '[deleted]'}, chunks: ${file.chunks?.length || 0}`);
  }

  for (const file of parsedDiff) {
    const filePath = file.to;
    if (!filePath || filePath === "/dev/null") continue; // Ignore deleted files and files without path
    
    for (const chunk of file.chunks) {
      const { prompt } = createPrompt(file, chunk, prDetails);
      
      // Get starting line number safely by checking the type of change
      const firstChange = chunk.changes[0] || {};
      let startLine = 'unknown';
      if ('ln' in firstChange) {
        startLine = String(firstChange.ln);
      } else if ('ln2' in firstChange) {
        startLine = String(firstChange.ln2);
      }
      
      console.log(`Sending to AI - File: ${filePath}, Chunk starting at line: ${startLine}`);
      console.log(`AI Prompt preview (first 500 chars): ${prompt.substring(0, 500)}...`);
      
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): {prompt: string} {
  // Default prompt template that will be used if the file doesn't exist
  const defaultPromptTemplate = `As a technical writer who has profound knowledge, your task is to review pull requests of user documentation.

IMPORTANT: You MUST follow these formatting instructions exactly:
1. Your response MUST be a valid JSON object with the following structure:
   {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>", "suggestion": "<improved version of the original line>"}]}
2. Do NOT include any markdown code blocks (like \`\`\`json) around your JSON.
3. Ensure all JSON keys and values are properly quoted with double quotes.
4. Escape any double quotes within string values with a backslash (\\").
5. Do NOT include any explanations or text outside of the JSON object.

Review Guidelines:
- Do not give positive comments or compliments.
- Do not improve the wording of UI strings or messages returned by CLI.
- Focus on improving the clarity, accuracy, and readability of the content.
- Ensure the documentation is easy to understand for TiDB users.
- Review not just the wording but also the logic and structure of the content.
- Review the document in the context of the overall user experience and functionality described.
- Provide "reviews" ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the review comment in the language of the documentation.
- For EVERY review comment of a specific line, "suggestion" MUST be the improved version of the original line. If the beginning of the original line contains Markdown syntax such as blank spaces for indentation, "-", "+", "*" for unordered list, or ">" for notes, keep them unchanged.

Example of a valid response:

{"reviews": [{"lineNumber": 42, "reviewComment": "The sentence is not clear enough. It is recommended to clarify the relationship between compression efficiency and compression rate, and to supplement the explanation of the default value.", "suggestion": "Set the compression efficiency of the lz4 compression algorithm used when writing raft log files to raft-engine, ranging from 1 to 16. The lower the value, the higher the compression rate, but the lower the compression rate; the higher the value, the lower the compression rate, but the higher the compression rate. The default value is 1, which means to prioritize compression rate."}]}

Review the following diff in the file "\${filename}" and take the pull request title and description into account when writing the response.

Pull request title: \${title}
Pull request description:

---
\${description}
---

Git diff to review:

\`\`\`diff
\${diff_content}
\${diff_changes}
\`\`\``;

  try {
    // Read the template file from the configured path
    // If it's a relative path, resolve it from the current working directory
    const templatePath = path.isAbsolute(PROMPT_PATH)
      ? PROMPT_PATH
      : path.resolve(process.cwd(), PROMPT_PATH);
    
    try {
      // Check if file exists before trying to read it
      readFileSync(templatePath, { encoding: 'utf8', flag: 'r' });
      console.log(`✅ Using custom prompt template from: ${templatePath}`);
      core.info(`Using custom prompt template from: ${templatePath}`);
      let template = readFileSync(templatePath, 'utf8');
      
      // Replace placeholders with actual values - using global replacement
      template = template
        .replace(/\${filename}/g, file.to || '')
        .replace(/\${title}/g, prDetails.title)
        .replace(/\${description}/g, prDetails.description)
        .replace(/\${diff_content}/g, chunk.content)
        .replace(/\${diff_changes}/g, chunk.changes
          // @ts-expect-error - ln and ln2 exists where needed
          .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
          .join("\n"));
      
      return { prompt: template };
    } catch (fileError) {
      // File doesn't exist or can't be read, fall back to default prompt
      console.log(`⚠️ Custom prompt file not found at: ${templatePath}. Using default prompt.`);
      core.warning(`Custom prompt file not found at: ${templatePath}. Using default prompt.`);
      
      // Use the default prompt template
      let template = defaultPromptTemplate;
      
      // Replace placeholders with actual values - using global replacement
      template = template
        .replace(/\${filename}/g, file.to || '')
        .replace(/\${title}/g, prDetails.title)
        .replace(/\${description}/g, prDetails.description)
        .replace(/\${diff_content}/g, chunk.content)
        .replace(/\${diff_changes}/g, chunk.changes
          // @ts-expect-error - ln and ln2 exists where needed
          .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
          .join("\n"));
      
      return { prompt: template };
    }
  } catch (error) {
    console.error(`Error in createPrompt:`, error);
    throw new Error(`Failed to create prompt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
  suggestion: string;
}> | null> {
  if (API_PROVIDER === "openai") {
    return getOpenAIResponse(prompt);
  } else if (API_PROVIDER === "deepseek") {
    try {
      const deepseekResponse = await getDeepseekResponse(prompt);
      if (deepseekResponse !== null) {
        return deepseekResponse;
      }
      
      // If Deepseek API fails and OpenAI API key is available, try OpenAI as fallback
      if (OPENAI_API_KEY) {
        console.log("Deepseek API failed, falling back to OpenAI...");
        return getOpenAIResponse(prompt);
      }
      return null;
    } catch (error) {
      console.error("Error with Deepseek API, checking for fallback:", error);
      // If OpenAI API key is available, try OpenAI as fallback
      if (OPENAI_API_KEY) {
        console.log("Falling back to OpenAI...");
        return getOpenAIResponse(prompt);
      }
      return null;
    }
  } else {
    console.error(`Unsupported API provider: ${API_PROVIDER}`);
    return null;
  }
}

async function getOpenAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
  suggestion: string;
}> | null> {
  if (!openai) {
    console.error("OpenAI client not initialized");
    return null;
  }

  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.1,
    max_tokens: 800,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    // Check if the model supports the JSON response format
    const supportsJsonFormat = OPENAI_API_MODEL.includes("gpt-4-turbo") || 
                              OPENAI_API_MODEL.includes("gpt-4-0125") || 
                              OPENAI_API_MODEL.includes("gpt-4-1106") || 
                              OPENAI_API_MODEL.includes("gpt-3.5-turbo-1106");

    const response = await openai.chat.completions.create({
      ...queryConfig,
      // Only add response_format if the model supports it
      ...(supportsJsonFormat
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: "You are an expert technical writer who provides detailed, helpful documentation reviews in JSON format."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    console.log("AI response:", res.substring(0, 100) + (res.length > 100 ? "..." : ""));
    
    // Try several approaches to extract valid JSON
    
    // First, try direct parsing
    try {
      const parsed = JSON.parse(res);
      if (parsed.reviews && Array.isArray(parsed.reviews)) {
        return parsed.reviews;
      } else {
        console.log("Response doesn't contain valid reviews array:", res);
      }
    } catch (parseError) {
      console.error("Error parsing OpenAI response as JSON:", parseError);
    }
    
    // Second, look for JSON-like patterns in the response
    try {
      const jsonRegex = /\{(?:"reviews"|'reviews'):\s*\[(.*?)\]\}/s;
      const match = res.match(jsonRegex);
      if (match) {
        const jsonString = match[0].replace(/'/g, '"');
        const parsed = JSON.parse(jsonString);
        if (parsed.reviews && Array.isArray(parsed.reviews)) {
          return parsed.reviews;
        }
      }
    } catch (regexParseError) {
      console.error("Failed to extract JSON with regex:", regexParseError);
    }
    
    // Finally, try to extract from code blocks
    try {
      const codeBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
      const match = res.match(codeBlockRegex);
      if (match && match[1]) {
        const jsonString = match[1];
        const parsed = JSON.parse(jsonString);
        if (parsed.reviews && Array.isArray(parsed.reviews)) {
          return parsed.reviews;
        }
      }
    } catch (blockParseError) {
      console.error("Failed to extract JSON from code block:", blockParseError);
    }
    
    console.error("All JSON parsing approaches failed");
    return [];
    
  } catch (error) {
    console.error("Error with OpenAI API:", error);
    return [];
  }
}

async function getDeepseekResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
  suggestion: string;
}> | null> {
  if (!DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is not set");
    return null;
  }

  //console.log("Calling Deepseek API...");
  //console.log("Available Deepseek models: deepseek-chat, deepseek-coder");
  
  const requestBody = {
    model: DEEPSEEK_API_MODEL,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0.2,
    max_tokens: 800,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0
  };
  
  //console.log(`Using Deepseek model: ${DEEPSEEK_API_MODEL}`);
  //console.log("Request body structure:", JSON.stringify({
  //  model: DEEPSEEK_API_MODEL,
  //  messages: [{role: "user", content: "prompt content (truncated)"}],
  //  temperature: 0.2,
  //  max_tokens: 800
  //}));
  
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Deepseek API error response: ${errorText}`);
    throw new Error(`Deepseek API error: ${response.status} ${response.statusText}\nDetails: ${errorText}`);
  }

  const data = await response.json();
  console.log("Deepseek API response received");
  
  // Extract the content from the response
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    console.error("No content in Deepseek response");
    return null;
  }

  // Print the content and add a new line
  console.log("Deepseek API response content:", content, "\n");
  
  try {
    // First attempt: try to parse the entire content as JSON
    try {
      const parsedJson = JSON.parse(content);
      if (parsedJson && parsedJson.reviews) {
        return parsedJson.reviews;
      }
    } catch (parseError) {
      console.error("Error parsing Deepseek response as JSON:", parseError);
    }
    
    // Second attempt: try to extract JSON from markdown code blocks
    const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
    const jsonMatch = content.match(jsonBlockRegex);
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsedJson = JSON.parse(jsonMatch[1]);
        if (parsedJson && parsedJson.reviews) {
          return parsedJson.reviews;
        }
      } catch (blockParseError) {
        console.error("Failed to parse JSON block:", blockParseError);
      }
    }
    
    console.error("Could not extract valid JSON from response");
    return null;
  } catch (error) {
    console.error("Error processing Deepseek response:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
    suggestion: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  if (!file.to) return [];
  
  const filePath = file.to; // 保存为变量以确保TypeScript知道它不可能是undefined
  console.log(`Creating comments for file ${filePath}`);
  
  return aiResponses.map((aiResponse: { lineNumber: string; reviewComment: string; suggestion: string }) => {
    const lineNum = aiResponse.lineNumber;
    console.log(`Processing suggestion for line ${lineNum}`);
    console.log(`Original suggestion: "${aiResponse.suggestion.substring(0, 100)}..."`);
    
    const suggestionHasLeadingSpace = aiResponse.suggestion.match(/^\s+/);
    if (suggestionHasLeadingSpace) {
      console.log(`Suggestion already has leading space: '${suggestionHasLeadingSpace[0].replace(/ /g, '·')}'`);
      return {
        body: `${aiResponse.reviewComment}\n\n\`\`\`\`suggestion\n${aiResponse.suggestion}\n\`\`\`\``,
        path: filePath,
        line: Number(lineNum),
      };
    }
    
    // Find the original line by reading directly from the file
    let originalIndent = '';
    let lineFound = false;
    
    try {
      if (existsSync(filePath)) {
        console.log(`Reading file: ${filePath}`);
        const fileContent = readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n');
        
        // Line numbers are 1-based, so adjust for 0-based array
        const lineIndex = Number(lineNum) - 1;
        if (lineIndex >= 0 && lineIndex < lines.length) {
          const line = lines[lineIndex];
          console.log(`Found line ${lineNum} content: "${line.substring(0, 50)}${line.length > 50 ? '...' : ''}"`);
          
          const indentMatch = line.match(/^(\s+)/);
          if (indentMatch) {
            originalIndent = indentMatch[0]; // 使用完整匹配而不是捕获组
            console.log(`Found indent for line ${lineNum}: '${originalIndent.replace(/ /g, '·')}' (${originalIndent.length} spaces)`);
            lineFound = true;
          } else {
            console.log(`Line ${lineNum} found in file but has no leading whitespace`);
          }
        } else {
          console.log(`Line ${lineNum} is out of range for file (has ${lines.length} lines)`);
        }
      } else {
        console.log(`File not found at ${filePath}`);
      }
    } catch (error) {
      console.error(`Error reading file: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Apply indentation to suggestion if found and needed
    let suggestionText = aiResponse.suggestion;
    if (originalIndent && !suggestionText.startsWith(originalIndent)) {
      suggestionText = originalIndent + suggestionText.trimStart();
      console.log(`Added indentation for line ${lineNum}. Result: '${suggestionText.substring(0, Math.min(50, suggestionText.length))}...'`);
    } else if (!originalIndent) {
      console.log(`No indent found for line ${lineNum}, using suggestion as-is`);
    } else {
      console.log(`Suggestion already has correct indentation, keeping as-is`);
    }
    
    return {
      body: `${aiResponse.reviewComment}\n\n\`\`\`\`suggestion\n${suggestionText}\n\`\`\`\``,
      path: filePath,
      line: Number(lineNum),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments,
      event: "COMMENT",
    });
  } catch (error) {
    console.error("Error creating review comment:", error);
    
    // If we get "Resource not accessible by integration" error, try to post a comment instead
    if (error instanceof Error && error.message.includes("Resource not accessible by integration")) {
      console.log("Permissions issue detected. Attempting to post a regular comment instead...");
      
      const commentBody = `### AI Review Comments\n\n${comments.map(c => 
        `**File:** ${c.path}, **Line:** ${c.line}\n${c.body}\n\n---\n`
      ).join('\n')}`;
      
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pull_number,
        body: commentBody
      });
    } else {
      throw error;
    }
  }
}

// Helper function to get the line number from a change
function getChangeLineNumber(change: any, lineNumber: number): boolean {
  if (change.type === 'add' && change.ln === lineNumber) {
    return true;
  } else if (change.type === 'normal' && change.ln2 === lineNumber) {
    return true;
  } else if (change.type === 'del' && change.ln === lineNumber) {
    return true;
  }
  return false;
}

async function main() {
  try {
    // Validate API provider configuration
    if (API_PROVIDER === "openai" && !OPENAI_API_KEY) {
      core.setFailed("OPENAI_API_KEY is required when API_PROVIDER is set to 'openai'");
      return;
    }
    
    if (API_PROVIDER === "deepseek" && !DEEPSEEK_API_KEY) {
      core.setFailed("DEEPSEEK_API_KEY is required when API_PROVIDER is set to 'deepseek'");
      return;
    }

    const prDetails = await getPRDetails();
    let diff: string | null;
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );
    
    // Check if the comment is triggered
    const isCommentTrigger = process.env.GITHUB_EVENT_NAME === "issue_comment";
    
    if (isCommentTrigger) {

      const commentUser = eventData.comment.user.login;
      
      console.log("REVIEW_MODE from input:", REVIEW_MODE);
      console.log("COMMIT_SHA from input:", COMMIT_SHA);
      console.log("BASE_SHA from input:", BASE_SHA);
      console.log("HEAD_SHA from input:", HEAD_SHA);
      console.log("Raw comment body:", eventData.comment.body);
      
      // Handle invalid review mode
      if (REVIEW_MODE === "invalid") {
        console.log("Invalid bot-review command format detected");
        await octokit.issues.createComment({
          owner: prDetails.owner,
          repo: prDetails.repo,
          issue_number: prDetails.pull_number,
          body: `❌ Invalid command format. Valid formats are:
- \`/bot-review\` - Review latest changes
- \`/bot-review: <commit-sha>\` - Review a single commit
- \`/bot-review: <base>..<head>\` - Review a commit range`
        });
        return;
      }
      
      // Get diff based on the comment content
      if (REVIEW_MODE === "single_commit" && COMMIT_SHA) {
        // Get the diff of a single commit
        console.log(`Reviewing single commit: ${COMMIT_SHA}`);
        try {
          const response = await octokit.repos.getCommit({
            owner: prDetails.owner,
            repo: prDetails.repo,
            ref: COMMIT_SHA,
            mediaType: { format: "diff" }
          });
          // @ts-expect-error - response.data is a string
          diff = response.data;
        } catch (error) {
          handleGitHubPermissionError(error, prDetails, isCommentTrigger);
          throw error;
        }
      } else if (REVIEW_MODE === "commit_range" && BASE_SHA) {
        // Process commit range
        console.log("Processing commit range mode");
        
        // Get base and head SHAs
        let baseSha = BASE_SHA;
        let headSha = HEAD_SHA;
        
        // Check if BASE_SHA contains full range format (like "sha1..sha2")
        if (BASE_SHA.includes('..')) {
          const parts = BASE_SHA.split('..');
          baseSha = parts[0];
          headSha = parts.length > 1 ? parts[1] : HEAD_SHA;
          console.log(`BASE_SHA contains '..' pattern, extracted baseSha=${baseSha}, headSha=${headSha}`);
        } else {
          console.log(`Using separate BASE_SHA and HEAD_SHA values: base=${baseSha}, head=${headSha}`);
        }
        
        // Trim any whitespace that might have been included in the SHAs
        baseSha = baseSha.trim();
        headSha = headSha.trim();
        
        if (!baseSha || !headSha) {
          throw new Error(`Invalid commit range: ${baseSha}..${headSha}`);
        }
        
        console.log(`Comparing commit range: ${baseSha} → ${headSha}`);
        
        try {
          console.log(`Calling GitHub API to compare commits - owner: ${prDetails.owner}, repo: ${prDetails.repo}`);
          const response = await octokit.repos.compareCommits({
            owner: prDetails.owner,
            repo: prDetails.repo,
            base: baseSha,
            head: headSha,
            headers: {
              accept: "application/vnd.github.v3.diff",
            }
          });
          
          if (!response.data) {
            throw new Error("Empty response from GitHub API");
          }
          
          diff = typeof response.data === 'string' ? response.data : String(response.data);
          console.log("Diff length:", diff.length);
          console.log("Diff preview (first 200 chars):", diff.substring(0, 200));
          console.log("Number of files changed in diff:", (diff.match(/^diff --git/gm) || []).length);
          
          // Debug - log the file paths in the diff
          const fileMatches = diff.match(/^diff --git a\/(.*?) b\/(.*?)$/gm);
          if (fileMatches) {
            console.log("Files in diff:", fileMatches.map(m => m.replace(/^diff --git a\/.*? b\//, '')).slice(0, 10).join(', ') + 
              (fileMatches.length > 10 ? ` and ${fileMatches.length - 10} more...` : ''));
          }
        } catch (apiError) {
          handleGitHubPermissionError(apiError, prDetails, isCommentTrigger);
          console.error("Error calling GitHub API:", apiError);
          throw new Error(`Failed to get diff from GitHub API: ${apiError instanceof Error ? apiError.message : String(apiError)}`);
        }
      } else {
        // Get the diff of the latest PR changes
        console.log("Reviewing latest PR changes");
        try {
          diff = await getDiff(
            prDetails.owner,
            prDetails.repo,
            prDetails.pull_number
          );
          
          if (!diff) {
            throw new Error("No diff returned from GitHub API");
          }
        } catch (diffError) {
          handleGitHubPermissionError(diffError, prDetails, isCommentTrigger);
          console.error("Error getting PR diff:", diffError);
          throw diffError;
        }
      }
    } else if (eventData.action === "opened") {
      try {
        diff = await getDiff(
          prDetails.owner,
          prDetails.repo,
          prDetails.pull_number
        );
      } catch (error) {
        handleGitHubPermissionError(error, prDetails, isCommentTrigger);
        throw error;
      }
    } else if (eventData.action === "synchronize") {
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;
      try {
        const response = await octokit.repos.compareCommits({
          headers: {
            accept: "application/vnd.github.v3.diff",
          },
          owner: prDetails.owner,
          repo: prDetails.repo,
          base: newBaseSha,
          head: newHeadSha,
        });
        diff = String(response.data);
      } catch (error) {
        handleGitHubPermissionError(error, prDetails, isCommentTrigger);
        throw error;
      }
    } else {
      console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
      return;
    }

    if (!diff || typeof diff !== 'string' || diff.trim() === '') {
      console.error("Empty or invalid diff returned from GitHub API");
      throw new Error("Failed to retrieve diff from GitHub API");
    }

    const parsedDiff = parseDiff(diff);

    if (!parsedDiff || parsedDiff.length === 0) {
      console.error("Failed to parse diff:", diff);
      throw new Error("Failed to parse diff from GitHub API");
    }

    const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());

    const filteredDiff = parsedDiff.filter((file) => {
      return !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
      );
    });

    if (filteredDiff.length === 0) {
      console.log("No files to review after filtering");
      if (isCommentTrigger) {
        await octokit.issues.createComment({
          owner: prDetails.owner,
          repo: prDetails.repo,
          issue_number: prDetails.pull_number,
          body: `✅ AI review completed, no files to review after filtering.`
        });
      }
      return;
    }

    // Track if we had critical errors that should fail the action
    let hadCriticalErrors = false;
    
    try {
      const comments = await analyzeCode(filteredDiff, prDetails);

      if (comments.length > 0) {
        try {
          await createReviewComment(
            prDetails.owner,
            prDetails.repo,
            prDetails.pull_number,
            comments
          );
          
          // If the comment is triggered, reply a comment to indicate the completion
          if (isCommentTrigger) {
            await octokit.issues.createComment({
              owner: prDetails.owner,
              repo: prDetails.repo,
              issue_number: prDetails.pull_number,
              body: `✅ AI review completed, ${comments.length} comments generated.`
            });
          }
        } catch (reviewError) {
          hadCriticalErrors = true;
          console.error("Error creating review comments:", reviewError);
          
          // If this is a permissions issue, we have already tried the fallback in createReviewComment
          if (!(reviewError instanceof Error && reviewError.message.includes("Resource not accessible by integration"))) {
            throw reviewError;
          }
        }
      } else {
        // If the comment is triggered but no comments are generated, also reply a message
        if (isCommentTrigger) {
          await octokit.issues.createComment({
            owner: prDetails.owner,
            repo: prDetails.repo,
            issue_number: prDetails.pull_number,
            body: `✅ AI review completed, no issues found.`
          });
        }
      }
    } catch (analyzeError) {
      hadCriticalErrors = true;
      if (analyzeError instanceof Error) {
        core.setFailed(`Critical error during analysis: ${analyzeError.message}`);
        
        // If the comment is triggered, reply the error information
        if (isCommentTrigger) {
          await octokit.issues.createComment({
            owner: prDetails.owner,
            repo: prDetails.repo,
            issue_number: prDetails.pull_number,
            body: `❌ AI review failed: ${analyzeError.message}`
          });
        }
      } else {
        core.setFailed(`Unknown critical error during analysis: ${analyzeError}`);
        
        // If the comment is triggered, reply the error information
        if (isCommentTrigger) {
          await octokit.issues.createComment({
            owner: prDetails.owner,
            repo: prDetails.repo,
            issue_number: prDetails.pull_number,
            body: `❌ AI review failed: Unknown error`
          });
        }
      }
    }
    
    // Only report success if we didn't have critical errors
    if (!hadCriticalErrors) {
      core.info("AI Review completed successfully");
    }
    
  } catch (error) {
    // Log the error details
    if (error instanceof Error) {
      core.setFailed(`Error in AI Review: ${error.message}`);
      console.error("Error details:", error.stack);
    } else {
      core.setFailed(`Unknown error in AI Review: ${error}`);
      console.error("Unknown error:", error);
    }
    
    // Ensure the process exits with a non-zero status code
    process.exit(1);
  }
}

// Helper function to handle GitHub permission errors
function handleGitHubPermissionError(error: unknown, prDetails: PRDetails, isCommentTrigger: boolean): boolean {
  if (error instanceof Error && error.message.includes("Resource not accessible by integration")) {
    console.log("GitHub permission error detected. Checking if we can notify the user...");
    
    if (isCommentTrigger) {
      try {
        octokit.issues.createComment({
          owner: prDetails.owner,
          repo: prDetails.repo,
          issue_number: prDetails.pull_number,
          body: `❌ Review failed: Insufficient permissions to access repository data. Please check the GitHub token permissions and make sure it has access to the repository contents and pull requests.`
        }).catch(commentError => {
          console.error("Also failed to post error comment:", commentError);
        });
      } catch (commentError) {
        console.error("Failed to post permission error comment:", commentError);
      }
    }
    
    return true;
  }
  return false;
}

main().catch((error) => {
  console.error("Error:", error);
  core.setFailed(`Unhandled error in AI Review: ${error}`);
  process.exit(1);
});
