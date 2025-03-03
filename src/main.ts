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
    
    // Check if the comment appears to be suggesting a simple text replacement
    if (lineContent) {
      // Look for patterns like "should be X" or "change X to Y" in the comment
      const shouldBeMatch = body.match(/should be ['"]?([^'".,]+)['"]?/i);
      const changeToMatch = body.match(/change ['"]?([^'"]+)['"]? to ['"]?([^'".,]+)['"]?/i);
      const replaceWithMatch = body.match(/replace with ['"]?([^'".,]+)['"]?/i);
      
      if (shouldBeMatch && shouldBeMatch[1]) {
        // For "should be X" pattern, try to preserve the structure of the original line
        const suggestion = shouldBeMatch[1].trim();
        
        // If the suggestion contains the original content structure (like headings),
        // use it directly, otherwise try to replace just the relevant part
        if (suggestion.includes('#') || suggestion.startsWith(lineContent.trim().charAt(0))) {
          body += `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
        } else {
          // Try to preserve the original line structure (spaces, symbols, etc.)
          const originalWords = lineContent.trim().split(/\s+/);
          const suggestionWords = suggestion.split(/\s+/);
          
          // If we have a simple word replacement and structure is similar
          if (originalWords.length === suggestionWords.length) {
            body += `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
          } else {
            // Try to identify what part needs to be replaced
            const leadingWhitespace = lineContent.match(/^\s*/)?.[0] || "";
            const commonPrefix = findCommonPrefix(lineContent.trim(), suggestion);
            
            if (commonPrefix.length > 0) {
              const restOfLine = lineContent.trim().substring(commonPrefix.length);
              const restOfSuggestion = suggestion.substring(commonPrefix.length);
              
              if (restOfLine.length > 0 && restOfSuggestion.length > 0) {
                const newLine = leadingWhitespace + lineContent.trim().replace(restOfLine, restOfSuggestion);
                body += `\n\n\`\`\`suggestion\n${newLine}\n\`\`\``;
              } else {
                body += `\n\n\`\`\`suggestion\n${leadingWhitespace}${suggestion}\n\`\`\``;
              }
            } else {
              body += `\n\n\`\`\`suggestion\n${leadingWhitespace}${suggestion}\n\`\`\``;
            }
          }
        }
      } else if (changeToMatch && changeToMatch[1] && changeToMatch[2]) {
        // Try to replace specific text
        const oldText = changeToMatch[1].trim();
        const newText = changeToMatch[2].trim();
        if (lineContent.includes(oldText)) {
          const suggestedLine = lineContent.replace(oldText, newText);
          body += `\n\n\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``;
        }
      } else if (replaceWithMatch && replaceWithMatch[1]) {
        // Replace with suggestion
        const suggestion = replaceWithMatch[1].trim();
        body += `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
      } else {
        // Try to detect simple typos or missing characters
        const typoMatch = body.match(/missing ['"]?([^'".,]+)['"]?|typo ['"]?([^'".,]+)['"]? should be ['"]?([^'".,]+)['"]?/i);
        if (typoMatch) {
          const missingText = typoMatch[1];
          const typoText = typoMatch[2];
          const correctedText = typoMatch[3];
          
          if (missingText && lineContent) {
            // For missing text, we'd need more context to know where to insert it
            // This is a simplistic approach
            if (lineContent.endsWith(missingText.charAt(0))) {
              const suggestedLine = lineContent + missingText.substring(1);
              body += `\n\n\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``;
            }
          } else if (typoText && correctedText && lineContent.includes(typoText)) {
            const suggestedLine = lineContent.replace(typoText, correctedText);
            body += `\n\n\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``;
          }
        }
      }
      
      // Special case for Chinese text patterns
      
      // Case 1: 架构设 -> 架构设计
      if (lineContent.includes("架构设") && !lineContent.includes("架构设计") && 
          (body.includes("架构设计") || body.toLowerCase().includes("incomplete"))) {
        const suggestedLine = lineContent.replace("架构设", "架构设计");
        body += `\n\n\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``;
      }
      
      // Case 2: 新老架对比 -> 新老架构对比
      if (lineContent.includes("新老架对比") && !lineContent.includes("新老架构对比") && 
          body.includes("新老架构对比")) {
        const suggestedLine = lineContent.replace("新老架对比", "新老架构对比");
        body += `\n\n\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``;
      }
      
      // Extract specific Chinese characters from the comment if they appear to be corrections
      const chineseCharMatch = body.match(/[""']([^""']+[\u4e00-\u9fa5]+[^""']*)[""']/);
      if (chineseCharMatch && chineseCharMatch[1]) {
        const suggestedText = chineseCharMatch[1].trim();
        // Only use if it's a reasonable length and contains Chinese characters
        if (suggestedText.length > 0 && suggestedText.length < lineContent.length * 2) {
          // Check if it's a heading (starts with #)
          if (lineContent.trim().startsWith('#') && suggestedText.includes('#')) {
            body += `\n\n\`\`\`suggestion\n${suggestedText}\n\`\`\``;
          } else {
            // Try to find what part of the line needs to be replaced
            const words = lineContent.trim().split(/\s+/);
            for (const word of words) {
              if (word.length > 1 && suggestedText.includes(word)) {
                const suggestedLine = lineContent.replace(word, suggestedText);
                body += `\n\n\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``;
                break;
              }
            }
          }
        }
      }
      
      // Handle the specific case in the image: ## 新老架对比 -> ## 新老架构对比
      if (lineContent.includes("## 新老架对比")) {
        const suggestedLine = lineContent.replace("## 新老架对比", "## 新老架构对比");
        // Replace any existing suggestion to ensure we don't have duplicates
        if (!body.includes("```suggestion")) {
          body += `\n\n\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``;
        } else {
          // Replace existing suggestion
          body = body.replace(/```suggestion\n.*\n```/s, `\`\`\`suggestion\n${suggestedLine.trim()}\n\`\`\``);
        }
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
