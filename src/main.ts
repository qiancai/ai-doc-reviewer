import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const API_PROVIDER: string = core.getInput("API_PROVIDER") || "openai";
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = API_PROVIDER === "openai" ? core.getInput("OPENAI_API_MODEL") : "";
const DEEPSEEK_API_KEY: string = core.getInput("DEEPSEEK_API_KEY");
const DEEPSEEK_API_MODEL: string = API_PROVIDER === "deepseek" ? core.getInput("DEEPSEEK_API_MODEL") || "deepseek-chat" : "";
const REVIEW_MODE: string = core.getInput("REVIEW_MODE") || "default";
const COMMIT_SHA: string = core.getInput("COMMIT_SHA") || "";
const BASE_SHA: string = core.getInput("BASE_SHA") || "";
const HEAD_SHA: string = core.getInput("HEAD_SHA") || "";
const ALLOWED_USERS: string[] = core.getInput("ALLOWED_USERS").split(",").map(u => u.trim());

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

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
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
function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `As a technical writer who has profound knowledge of databases, your task is to review pull requests of TiDB user documentation. 

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

{"reviews": [{"lineNumber": 42, "reviewComment": "该句描述不够清晰，建议明确说明压缩效率和压缩率的关系，并补充对默认值的解释。", "suggestion": "设置 raft-engine 在写 raft log 文件时所采用的 lz4 压缩算法的压缩效率，范围 [1, 16]。数值越低，压缩速率越高，但压缩率越低；数值越高，压缩速率越低，但压缩率越高。默认值 1 表示优先考虑压缩速率。"}]}

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
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
    temperature: 0.2,
    max_tokens: 800,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error with OpenAI API:", error);
    return null;
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
  return aiResponses.map((aiResponse: { lineNumber: string; reviewComment: string; suggestion: string }) => {
    if (!file.to) {
      return [];
    }
    return {
      body: `${aiResponse.reviewComment}\n\n\`\`\`\`suggestion\n${aiResponse.suggestion}\n\`\`\`\``, //use four backticks to wrap the suggestion because the response itself might contain code blocks in it
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  }).flat();
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
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
      // Check if the comment user has permission to trigger reviews
      const commentUser = eventData.comment.user.login;
      if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(commentUser)) {
        console.log(`User ${commentUser} is not allowed to trigger reviews. Allowed users: ${ALLOWED_USERS.join(", ")}`);
        return;
      }
      
      // Get diff based on the comment content
      if (REVIEW_MODE === "single_commit" && COMMIT_SHA) {
        // Get the diff of a single commit
        console.log(`Reviewing single commit: ${COMMIT_SHA}`);
        const response = await octokit.repos.getCommit({
          owner: prDetails.owner,
          repo: prDetails.repo,
          ref: COMMIT_SHA,
          mediaType: { format: "diff" }
        });
        // @ts-expect-error - response.data is a string
        diff = response.data;
      } else if (REVIEW_MODE === "commit_range" && BASE_SHA) {
        //split the commit range
        const parts = BASE_SHA.split('..');
        const baseSha = parts[0];
        const headSha = parts.length > 1 ? parts[1] : HEAD_SHA;
        
        if (!baseSha || !headSha) {
          throw new Error(`Invalid commit range: ${BASE_SHA}..${HEAD_SHA}`);
        }
        
        console.log(`Reviewing commit range: ${baseSha} to ${headSha}`);
        
        try {
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
        } catch (apiError) {
          console.error("Error calling GitHub API:", apiError);
          throw new Error(`Failed to get diff from GitHub API: ${apiError instanceof Error ? apiError.message : String(apiError)}`);
        }
      } else {
        // Get the diff of the latest PR changes
        console.log("Reviewing latest PR changes");
        diff = await getDiff(
          prDetails.owner,
          prDetails.repo,
          prDetails.pull_number
        );
      }
    } else if (eventData.action === "opened") {
      diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
    } else if (eventData.action === "synchronize") {
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;
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
          body: `✅ Code review completed, no files to review after filtering.`
        });
      }
      return;
    }

    // Track if we had critical errors that should fail the action
    let hadCriticalErrors = false;
    
    try {
      const comments = await analyzeCode(filteredDiff, prDetails);

      if (comments.length > 0) {
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
            body: `✅ Code review completed, ${comments.length} comments generated.`
          });
        }
      } else {
        // If the comment is triggered but no comments are generated, also reply a message
        if (isCommentTrigger) {
          await octokit.issues.createComment({
            owner: prDetails.owner,
            repo: prDetails.repo,
            issue_number: prDetails.pull_number,
            body: `✅ Code review completed, no issues found.`
          });
        }
      }
    } catch (analyzeError) {
      hadCriticalErrors = true;
      if (analyzeError instanceof Error) {
        core.setFailed(`Critical error during code analysis: ${analyzeError.message}`);
        
        // If the comment is triggered, reply the error information
        if (isCommentTrigger) {
          await octokit.issues.createComment({
            owner: prDetails.owner,
            repo: prDetails.repo,
            issue_number: prDetails.pull_number,
            body: `❌ Code review failed: ${analyzeError.message}`
          });
        }
      } else {
        core.setFailed(`Unknown critical error during code analysis: ${analyzeError}`);
        
        // If the comment is triggered, reply the error information
        if (isCommentTrigger) {
          await octokit.issues.createComment({
            owner: prDetails.owner,
            repo: prDetails.repo,
            issue_number: prDetails.pull_number,
            body: `❌ Code review failed: Unknown error`
          });
        }
      }
    }
    
    // Only report success if we didn't have critical errors
    if (!hadCriticalErrors) {
      core.info("AI Code Review completed successfully");
    }
    
  } catch (error) {
    // Log the error details
    if (error instanceof Error) {
      core.setFailed(`Error in AI Code Review: ${error.message}`);
      console.error("Error details:", error.stack);
    } else {
      core.setFailed(`Unknown error in AI Code Review: ${error}`);
      console.error("Unknown error:", error);
    }
    
    // Ensure the process exits with a non-zero status code
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  core.setFailed(`Unhandled error in AI Code Review: ${error}`);
  process.exit(1);
});
