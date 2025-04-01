# AI Doc Reviewer

AI Doc Reviewer is a GitHub Action forked from [ai-codereviewer](https://github.com/aidar-freeed/ai-codereviewer) that leverages AI capabilities to provide intelligent feedback and suggestions on your documentation pull requests. This powerful tool helps improve document quality and saves technical writers time by automating the review process.

## Features

### Original features (from [ai-codereviewer](https://github.com/aidar-freeed/ai-codereviewer))

- Reviews pull requests using AI-powered analysis
- Provides intelligent comments and suggestions for improving content
- Filters out files that match specified exclude patterns
- Easy to set up and integrate into your GitHub workflow

### New features in AI Doc Reviewer

- Support for multiple AI providers:

    - OpenAI GPT-4 API
    - DeepSeek AI API

- Enhanced documentation review performance with [customized prompts](#customize-prompts) configured in your own repository and tailored for technical writing

- Flexible [PR comment-based review triggers](#how-to-trigger-a-review) with various options:

    - Review the entire PR
    - Review specific commits
    - Review changes between commits

## Setup

### Using OpenAI API

1. To use this GitHub Action with OpenAI, you need an OpenAI API key. If you don't have one, sign up for an API key
   at [OpenAI](https://beta.openai.com/signup).

2. Add the OpenAI API key as a GitHub Secret in your repository with the name `OPENAI_API_KEY`. You can find more information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/doc_review.yml` file in your repository and add the following content:

```yaml
name: AI Doc Review

on:
  workflow_dispatch:

  issue_comment:
    types:
      - created

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: >
      github.event_name == 'workflow_dispatch' ||
      (
        github.event_name == 'issue_comment' &&
        contains(github.event.comment.body, '/bot-review') &&
        contains('username1, username2, username3', github.event.comment.user.login)
      )
    steps:
      - name: Debug Info
        run: |
          echo "Event name: ${{ github.event_name }}"
          echo "Event type: ${{ github.event.action }}"
          echo "Comment body: ${{ github.event.comment.body || 'No comment body' }}"
          echo "Comment author: ${{ github.event.comment.user.login || 'No user' }}"

      - name: Checkout Repo
        uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Fetch all history for all branches and tags

      - name: Extract review parameters
        id: extract
        if: github.event_name == 'issue_comment'
        run: |
          COMMENT="${{ github.event.comment.body }}"
          echo "Raw comment: $COMMENT"

          # Match commit range
          if [[ "$COMMENT" =~ \/bot-review:[[:space:]]*([a-f0-9]{7,40})[[:space:]]*\.\.[[:space:]]*([a-f0-9]{7,40}) ]]; then
            echo "BASE_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "HEAD_SHA=${BASH_REMATCH[2]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=commit_range" >> $GITHUB_OUTPUT
            echo "Detected commit range with regex: ${BASH_REMATCH[1]}..${BASH_REMATCH[2]}"

          # Match a single commit
          elif [[ "$COMMENT" =~ \/bot-review:[[:space:]]+([a-f0-9]{7,40}) ]]; then
            echo "COMMIT_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=single_commit" >> $GITHUB_OUTPUT
            echo "Detected single commit: ${BASH_REMATCH[1]}"

          # Match "/bot-review" or "/bot-review "
          elif [[ "$COMMENT" =~ ^\/bot-review[[:space:]]*$ ]]; then
            echo "REVIEW_MODE=latest" >> $GITHUB_OUTPUT
            echo "Detected default review mode"

          # Invalid format
          else
            echo "REVIEW_MODE=invalid" >> $GITHUB_OUTPUT
            echo "Invalid bot-review command format"
          fi

          echo "Parameters output:"
          cat $GITHUB_OUTPUT

      - name: AI Doc Reviewer
        uses: qiancai/ai-codereviewer@test-gpt
        continue-on-error: false  # Ensure workflow fails if the action fails
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_PROVIDER: "openai"
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-4"  # Updated model name
          exclude: "**/*.json"  # Optional: exclude patterns separated by commas
          REVIEW_MODE: ${{ steps.extract.outputs.REVIEW_MODE || 'default' }}
          COMMIT_SHA: ${{ steps.extract.outputs.COMMIT_SHA || '' }}
          BASE_SHA: ${{ steps.extract.outputs.BASE_SHA || '' }}
          HEAD_SHA: ${{ steps.extract.outputs.HEAD_SHA || '' }}
          PROMPT_PATH: "doc-review-prompt-en.txt"
```

### Using DeepSeek API

1. To use this GitHub Action with DeepSeek, you need a DeepSeek API key. Sign up for an API key at [DeepSeek](https://platform.deepseek.com/).

2. Add the DeepSeek API key as a GitHub Secret in your repository with the name `DEEPSEEK_API_KEY`.

3. Create a `.github/workflows/doc_review.yml` file in your repository and add the following content:

```yaml
name: AI Doc Review

on:
  workflow_dispatch:

  issue_comment:
    types:
      - created

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: >
      github.event_name == 'workflow_dispatch' ||
      (
        github.event_name == 'issue_comment' &&
        contains(github.event.comment.body, '/bot-review') &&
        contains('username1, username2, username3', github.event.comment.user.login)
      )
    steps:
      - name: Debug Info
        run: |
          echo "Event name: ${{ github.event_name }}"
          echo "Event type: ${{ github.event.action }}"
          echo "Comment body: ${{ github.event.comment.body || 'No comment body' }}"
          echo "Comment author: ${{ github.event.comment.user.login || 'No user' }}"

      - name: Checkout Repo
        uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Fetch all history for all branches and tags

      - name: Extract review parameters
        id: extract
        if: github.event_name == 'issue_comment'
        run: |
          COMMENT="${{ github.event.comment.body }}"
          echo "Raw comment: $COMMENT"

          # Match commit range
          if [[ "$COMMENT" =~ \/bot-review:[[:space:]]*([a-f0-9]{7,40})[[:space:]]*\.\.[[:space:]]*([a-f0-9]{7,40}) ]]; then
            echo "BASE_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "HEAD_SHA=${BASH_REMATCH[2]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=commit_range" >> $GITHUB_OUTPUT
            echo "Detected commit range with regex: ${BASH_REMATCH[1]}..${BASH_REMATCH[2]}"

          # Match a single commit
          elif [[ "$COMMENT" =~ \/bot-review:[[:space:]]+([a-f0-9]{7,40}) ]]; then
            echo "COMMIT_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=single_commit" >> $GITHUB_OUTPUT
            echo "Detected single commit: ${BASH_REMATCH[1]}"

          # Match "/bot-review" or "/bot-review "
          elif [[ "$COMMENT" =~ ^\/bot-review[[:space:]]*$ ]]; then
            echo "REVIEW_MODE=latest" >> $GITHUB_OUTPUT
            echo "Detected default review mode"

          # Invalid format
          else
            echo "REVIEW_MODE=invalid" >> $GITHUB_OUTPUT
            echo "Invalid bot-review command format"
          fi

          echo "Parameters output:"
          cat $GITHUB_OUTPUT

      - name: AI Doc Reviewer
        uses: qiancai/ai-codereviewer@test-gpt
        continue-on-error: false  # Ensure workflow fails if the action fails
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_PROVIDER: "deepseek"  # or "openai" if you want to use OpenAI
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          DEEPSEEK_API_MODEL: "deepseek-chat"  # Updated model name
          exclude: "**/*.json"  # Optional: exclude patterns separated by commas
          REVIEW_MODE: ${{ steps.extract.outputs.REVIEW_MODE || 'default' }}
          COMMIT_SHA: ${{ steps.extract.outputs.COMMIT_SHA || '' }}
          BASE_SHA: ${{ steps.extract.outputs.BASE_SHA || '' }}
          HEAD_SHA: ${{ steps.extract.outputs.HEAD_SHA || '' }}
          PROMPT_PATH: "doc-review-prompt-zh.txt"
```

## Configuration parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | N/A | GitHub token for API access |
| `API_PROVIDER` | No | `openai` | AI provider to use (`openai` or `deepseek`) |
| `OPENAI_API_KEY` | Yes (if using OpenAI) | N/A | Your OpenAI API key |
| `OPENAI_API_MODEL` | No | `gpt-4` | OpenAI model to use |
| `DEEPSEEK_API_KEY` | Yes (if using DeepSeek) | N/A | Your DeepSeek API key |
| `DEEPSEEK_API_MODEL` | No | `deepseek-chat` | DeepSeek model to use |
| `exclude` | No | N/A | Comma-separated glob patterns for files to exclude |
| `PROMPT_PATH` | No | N/A | Path to the prompt file |

## Customize prompts

You can enhance the review performance of the AI Doc Reviewer by providing a custom prompt for your product in a text file and specifying the path in the `PROMPT_PATH` parameter of the `doc_review.yml` file.

For example, you can create a `doc-review-prompt.txt` file in the root directory of your repository, and add the content of the prompt to the file based on the following template:

- Prompt template for English documentation review: [doc-review-prompt-en.txt](/doc-review-prompt-en.txt)
- Prompt template for Chinese documentation review: [doc-review-prompt-zh.txt](/doc-review-prompt-zh.txt)

If you does not add any customized prompt, the AI Doc Reviewer will use the default prompt for the review.

### How to trigger a review

You can add the `/bot-review` command in the PR comment to trigger a review.

- **Review the latest PR changes:**

    ```
    /bot-review
    ```

    This triggers a review of the entire PR in its latest state, equivalent to the automatic review.

- **Review a specific commit:**

    ```
    /bot-review: 1a2b3c4d
    ```

   Where `1a2b3c4d` is the SHA of the commit to review. This can be a full SHA or an abbreviated version (at least 7 characters).

- **Review changes between two commits:**

    ```
    /bot-review: 1a2b3c4d..5e6f7g8h
    ```

   This will review all changes from `1a2b3c4d` (not included) to `5e6f7g8h` (included).

### Permission requirements

Only users listed in the following condition in the `doc_review.yml` GitHub Action configuration can trigger document reviews.

```yaml
      github.event_name == 'workflow_dispatch' ||
      (
        github.event_name == 'issue_comment' &&
        contains(github.event.comment.body, '/bot-review') &&
        contains('username1, username2, username3', github.event.comment.user.login)
      )
```

### Response

After triggering, the bot will do the following:

1. Start the document review process.
2. Add a comment on the PR when the review is complete, indicating the results.
3. Add specific review comments and suggestions to relevant document lines if issues are found.

If errors occur during the review, the bot will add an error message to the PR explaining the failure reason.

## How it works

The AI Doc Reviewer GitHub Action works as follows:

1. Retrieves the pull request diff from GitHub.
2. Filters out excluded files based on your configuration.
3. Divides document content into appropriate chunks for analysis.
4. Sends these chunks to the selected AI provider (OpenAI or DeepSeek).
5. Processes AI responses to generate helpful review comments.
6. Adds the review comments to the appropriate lines in the pull request.

The reviewer uses specialized prompts designed specifically for technical documentation review, focusing on:

- Clarity and readability
- Technical accuracy
- Consistency in terminology
- Grammar and style
- Documentation structure
- User comprehension

## Examples

### Sample PR comment review trigger

To trigger a review on the latest changes in a PR:

```
/bot-review
```

The bot will start the review. After completion, it will add review comments to specific lines and post a summary:

```
✅ AI review completed, 5 comments generated.
```

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Doc Reviewer GitHub Action.

To develop locally, take the following steps:

1. Clone the repository.
2. Install dependencies with `npm install`.
3. Make your changes.
4. Test locally.
5. Let the maintainer generate the final package (`npm run build && npm run package`).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
