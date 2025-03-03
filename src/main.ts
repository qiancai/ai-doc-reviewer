import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File, Change, AddChange, DeleteChange } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const API_PROVIDER: string = core.getInput("API_PROVIDER") || "openai";
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const DEEPSEEK_API_KEY: string = core.getInput("DEEPSEEK_API_KEY");
const DEEPSEEK_API_MODEL: string = core.getInput("DEEPSEEK_API_MODEL") || "deepseek-chat";

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
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
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
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

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
}> | null> {
  if (!openai) {
    console.error("OpenAI client not initialized");
    return null;
  }

  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
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
}> | null> {
  if (!DEEPSEEK_API_KEY) {
    console.error("Deepseek API key not provided");
    return null;
  }

  try {
    console.log("Calling Deepseek API...");
    console.log("Available Deepseek models: deepseek-chat, deepseek-coder");
    
    const requestBody = {
      model: DEEPSEEK_API_MODEL,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 700,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    };
    
    console.log(`Using Deepseek model: ${DEEPSEEK_API_MODEL}`);
    console.log("Request body structure:", JSON.stringify({
      model: DEEPSEEK_API_MODEL,
      messages: [{role: "user", content: "prompt content (truncated)"}],
      temperature: 0.2,
      max_tokens: 700
    }));
    
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
    console.log("Response structure:", JSON.stringify({
      id: data.id,
      object: data.object,
      model: data.model,
      choices: data.choices ? [{index: 0, message: {role: data.choices[0]?.message?.role}}] : null
    }));
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error("Unexpected Deepseek API response format:", JSON.stringify(data));
      return null;
    }
    
    const content = data.choices[0].message.content.trim();
    console.log("Raw response content:", content);
    
    // Extract JSON from markdown code blocks if present
    const jsonRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
    const jsonMatch = content.match(jsonRegex);
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsedContent = JSON.parse(jsonMatch[1]);
        if (!parsedContent.reviews) {
          console.log("Extracted JSON doesn't contain reviews array:", jsonMatch[1]);
          return [];
        }
        return parsedContent.reviews;
      } catch (parseError) {
        console.error("Error parsing extracted JSON:", parseError);
      }
    }
    
    // If no code block or parsing failed, try parsing the whole content
    try {
      const parsedContent = JSON.parse(content);
      if (!parsedContent.reviews) {
        console.log("Response doesn't contain reviews array:", content);
        return [];
      }
      return parsedContent.reviews;
    } catch (parseError) {
      console.error("Error parsing Deepseek response as JSON:", parseError);
      
      // Last resort: try to find any JSON-like structure in the content
      const lastJsonMatch = content.match(/\{[\s\S]*?\}/);
      if (lastJsonMatch) {
        try {
          const extractedJson = JSON.parse(lastJsonMatch[0]);
          if (!extractedJson.reviews) {
            console.log("Extracted JSON doesn't contain reviews array:", lastJsonMatch[0]);
            return [];
          }
          return extractedJson.reviews;
        } catch (e) {
          console.error("Failed to extract JSON from response:", e);
        }
      }
      
      console.error("Could not extract valid JSON from response");
      return [];
    }
  } catch (error) {
    console.error("Error with Deepseek API:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.map((aiResponse: { lineNumber: string; reviewComment: string }) => {
    if (!file.to) {
      return [];
    }

    // Get the line content for the specified line number
    const lineNumber = Number(aiResponse.lineNumber);
    let lineContent = "";
    
    // Find the content of the line being commented on
    for (const change of chunk.changes) {
      // Handle different types of changes
      const changeLineNumber = getChangeLineNumber(change, lineNumber);
      if (changeLineNumber) {
        lineContent = change.content;
        break;
      }
    }
    
    let body = aiResponse.reviewComment;
    
    // Only add suggestion if we have line content to work with
    if (lineContent && lineContent.trim().length > 0) {
      // Extract suggestion from the review comment
      const extractSuggestion = (comment: string): string | null => {
        // Common patterns for suggestions in review comments
        const patterns = [
          // "X should be Y" pattern
          { regex: /['"]?([^'"]+)['"]? should be ['"]?([^'"]+)['"]?/i, oldGroup: 1, newGroup: 2 },
          // "change X to Y" pattern
          { regex: /change ['"]?([^'"]+)['"]? to ['"]?([^'"]+)['"]?/i, oldGroup: 1, newGroup: 2 },
          // "X instead of Y" pattern
          { regex: /['"]?([^'"]+)['"]? instead of ['"]?([^'"]+)['"]?/i, oldGroup: 2, newGroup: 1 },
          // Chinese patterns
          { regex: /['"]?([^'"]+)['"]? 应为 ['"]?([^'"]+)['"]?/i, oldGroup: 1, newGroup: 2 },
          { regex: /['"]?([^'"]+)['"]? 改为 ['"]?([^'"]+)['"]?/i, oldGroup: 1, newGroup: 2 },
          { regex: /将 ['"]?([^'"]+)['"]? 改为 ['"]?([^'"]+)['"]?/i, oldGroup: 1, newGroup: 2 }
        ];
        
        for (const pattern of patterns) {
          const match = comment.match(pattern.regex);
          if (match && match[pattern.oldGroup] && match[pattern.newGroup]) {
            const oldText = match[pattern.oldGroup].trim();
            const newText = match[pattern.newGroup].trim();
            
            // Only proceed if the old text is actually in the line content
            if (lineContent.includes(oldText)) {
              return lineContent.replace(oldText, newText);
            }
          }
        }
        
        // If no pattern matched, look for quoted text that might be a suggestion
        const quotedTextMatch = comment.match(/['"]([^'"]+)['"]/g);
        if (quotedTextMatch && quotedTextMatch.length === 1) {
          // If there's only one quoted text, it might be a suggestion for the entire line
          const suggestion = quotedTextMatch[0].replace(/^['"]|['"]$/g, '').trim();
          if (suggestion && suggestion !== lineContent.trim()) {
            return suggestion;
          }
        } else if (quotedTextMatch && quotedTextMatch.length === 2) {
          // If there are two quoted texts, the second might be the suggestion for the first
          const oldText = quotedTextMatch[0].replace(/^['"]|['"]$/g, '').trim();
          const newText = quotedTextMatch[1].replace(/^['"]|['"]$/g, '').trim();
          
          if (lineContent.includes(oldText)) {
            return lineContent.replace(oldText, newText);
          }
        }
        
        return null;
      };
      
      const suggestion = extractSuggestion(body);
      if (suggestion) {
        body += `\n\n\`\`\`suggestion\n${suggestion.trim()}\n\`\`\``;
      }
    }
    
    return {
      body: body,
      path: file.to,
      line: lineNumber,
    };
  }).flat();
}

// Helper function to find common prefix between two strings
function findCommonPrefix(str1: string, str2: string): string {
  let i = 0;
  while (i < str1.length && i < str2.length && str1.charAt(i) === str2.charAt(i)) {
    i++;
  }
  return str1.substring(0, i);
}

// Helper function to get line number from different change types
function getChangeLineNumber(change: Change, targetLineNumber: number): boolean {
  if ('ln' in change && change.ln === targetLineNumber) {
    return true;
  }
  if ('ln2' in change && change.ln2 === targetLineNumber) {
    return true;
  }
  return false;
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

async function main() {
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

  if (eventData.action === "opened") {
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

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s: string) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
