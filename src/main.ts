import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
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
  return `As a technical writer who has profound knowledge of databases, your task is to review pull requests of TiDB user documentation. Instructions:
- Provide the response in the following JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment with suggestion>"}]}
- Do not give positive comments or compliments.
- Do not improve the wording of UI strings or messages returned by CLI.
- Focus on improving the clarity, accuracy, and readability of the content.
- Ensure the documentation is easy to understand for TiDB users.
- Review not just the wording but also the logic and structure of the content.
- Review the document in the context of the overall user experience and functionality described.
- Provide review comments and suggested changes ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the review comment in GitHub Markdown format.
- CRITICAL: For EVERY review comment, YOU MUST include a suggestion block with the exact replacement text.
- The suggestion block MUST be included directly in the reviewComment field.

Example of a proper review comment with suggestion:

"该句中有一个 typo，“架构”这个词中少了一个“构”字。

\`\`\`\`suggestion
- 作为实验性特性，TiCDC v9.0 的新架构尚未完全实现旧架构中的所有功能，这些功能将在后续的 GA 版本中完整实现，具体包括:
\`\`\`\`"

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
    temperature: 0.3,
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
      temperature: 0.3,
      max_tokens: 800,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    };
    
    console.log(`Using Deepseek model: ${DEEPSEEK_API_MODEL}`);
    console.log("Request body structure:", JSON.stringify({
      model: DEEPSEEK_API_MODEL,
      messages: [{role: "user", content: "prompt content (truncated)"}],
      temperature: 0.3,
      max_tokens: 800
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
    return {
      body: aiResponse.reviewComment,
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
      .map((s) => s.trim());

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
    
    // Successfully completed
    core.info("AI Code Review completed successfully");
    
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
