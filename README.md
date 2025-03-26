# AI Doc Reviewer

AI Doc Reviewer is a GitHub Action forked from [ai-codereviewer](https://github.com/aidar-freeed/ai-codereviewer) that leverages AI capabilities to provide intelligent feedback and suggestions on your documentation pull requests. This powerful tool helps improve document quality and saves technical writers time by automating the review process.

## Features

### Original features (from [ai-codereviewer](https://github.com/aidar-freeed/ai-codereviewer))

- Reviews pull requests using AI-powered analysis
- Provides intelligent comments and suggestions for improving content
- Filters out files that match specified exclude patterns
- Easy to set up and integrate into your GitHub workflow

### New features

- Support for multiple AI providers:

    - OpenAI's GPT-4 API
    - DeepSeek AI API

- Specialized for documentation review with customized prompts tailored for technical writing

- Support [using PR comments to trigger manual reviews](#triggering-pr-review-via-pr-comments) with various options:

    - Review entire PR
    - Review specific commits
    - Review changes between commits
    - Configurable user permissions for triggering manual reviews

- Integration with style guides:
  
    - Reference organization-specific style guides and terminology guides
    - AI reviews documentation against established writing standards
    - Support for GitHub-hosted style guides in both Markdown and other formats

## Setup

### Using OpenAI API

1. To use this GitHub Action with OpenAI, you need an OpenAI API key. If you don't have one, sign up for an API key
   at [OpenAI](https://beta.openai.com/signup).

2. Add the OpenAI API key as a GitHub Secret in your repository with the name `OPENAI_API_KEY`. You can find more
   information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/doc_review.yml` file in your repository and add the following content:

```yaml
name: AI Doc Review

on:
  #pull_request:
  #  types:
  #    - opened
  #    - synchronize
  #    - reopened
  issue_comment:
    types:
      - created

permissions: write-all

jobs:
  review:
    runs-on: ubuntu-latest
    if: |
      (github.event_name == 'pull_request') || 
      (github.event_name == 'issue_comment' && 
       github.event.issue.pull_request && 
       startsWith(github.event.comment.body, '/bot-review'))
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Fetch all history for all branches and tags

      - name: Extract review parameters
        id: extract
        if: github.event_name == 'issue_comment'
        run: |
          COMMENT="${{ github.event.comment.body }}"
          if [[ "$COMMENT" =~ /bot-review:\ *([a-fA-F0-9]+) ]]; then
            echo "COMMIT_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=single_commit" >> $GITHUB_OUTPUT
          elif [[ "$COMMENT" =~ /bot-review:\ *([a-fA-F0-9]+)\ *\.\.\ *([a-fA-F0-9]+) ]]; then
            echo "BASE_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "HEAD_SHA=${BASH_REMATCH[2]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=commit_range" >> $GITHUB_OUTPUT
          else
            echo "REVIEW_MODE=latest" >> $GITHUB_OUTPUT
          fi

      - name: AI Doc Reviewer
        uses: qiancai/ai-doc-reviewer@main
        continue-on-error: false
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_PROVIDER: "openai"
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-4"
          exclude: "**/*.json"
          REVIEW_MODE: ${{ steps.extract.outputs.REVIEW_MODE || 'default' }}
          COMMIT_SHA: ${{ steps.extract.outputs.COMMIT_SHA || '' }}
          BASE_SHA: ${{ steps.extract.outputs.BASE_SHA || '' }}
          HEAD_SHA: ${{ steps.extract.outputs.HEAD_SHA || '' }}
          ALLOWED_USERS: "username1,username2"
          STYLE_GUIDE_URL: "https://github.com/pingcap/docs-cn/blob/master/resources/pingcap-style-guide-zh.pdf"
          TERMS_GUIDE_URL: "https://github.com/pingcap/docs-cn/blob/master/resources/tidb-terms.md"
```

### Using DeepSeek API

1. To use this GitHub Action with DeepSeek, you need a DeepSeek API key. Sign up for an API key at [DeepSeek](https://platform.deepseek.com/).

2. Add the DeepSeek API key as a GitHub Secret in your repository with the name `DEEPSEEK_API_KEY`.

3. Create a `.github/workflows/doc_review.yml` file in your repository and add the following content:

```yaml
name: AI Doc Review

on:
  #pull_request:
  #  types:
  #    - opened
  #    - synchronize
  #    - reopened
  issue_comment:
    types:
      - created

permissions: write-all

jobs:
  review:
    runs-on: ubuntu-latest
    if: |
      (github.event_name == 'pull_request') || 
      (github.event_name == 'issue_comment' && 
       github.event.issue.pull_request && 
       startsWith(github.event.comment.body, '/bot-review'))
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Fetch all history for all branches and tags

      - name: Extract review parameters
        id: extract
        if: github.event_name == 'issue_comment'
        run: |
          COMMENT="${{ github.event.comment.body }}"
          if [[ "$COMMENT" =~ /bot-review:\ *([a-fA-F0-9]+) ]]; then
            echo "COMMIT_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=single_commit" >> $GITHUB_OUTPUT
          elif [[ "$COMMENT" =~ /bot-review:\ *([a-fA-F0-9]+)\ *\.\.\ *([a-fA-F0-9]+) ]]; then
            echo "BASE_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "HEAD_SHA=${BASH_REMATCH[2]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=commit_range" >> $GITHUB_OUTPUT
          else
            echo "REVIEW_MODE=latest" >> $GITHUB_OUTPUT
          fi

      - name: AI Doc Reviewer
        uses: qiancai/ai-doc-reviewer@main
        continue-on-error: false
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_PROVIDER: "deepseek"
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          DEEPSEEK_API_MODEL: "deepseek-chat"
          exclude: "**/*.json"
          REVIEW_MODE: ${{ steps.extract.outputs.REVIEW_MODE || 'default' }}
          COMMIT_SHA: ${{ steps.extract.outputs.COMMIT_SHA || '' }}
          BASE_SHA: ${{ steps.extract.outputs.BASE_SHA || '' }}
          HEAD_SHA: ${{ steps.extract.outputs.HEAD_SHA || '' }}
          ALLOWED_USERS: "username1,username2"
          STYLE_GUIDE_URL: "https://github.com/pingcap/docs-cn/blob/master/resources/pingcap-style-guide-zh.pdf"
          TERMS_GUIDE_URL: "https://github.com/pingcap/docs-cn/blob/master/resources/tidb-terms.md"
```

## Configuration Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | N/A | GitHub token for API access |
| `API_PROVIDER` | No | `openai` | AI provider to use (`openai` or `deepseek`) |
| `OPENAI_API_KEY` | Yes (if using OpenAI) | N/A | Your OpenAI API key |
| `OPENAI_API_MODEL` | No | `gpt-4` | OpenAI model to use |
| `DEEPSEEK_API_KEY` | Yes (if using DeepSeek) | N/A | Your DeepSeek API key |
| `DEEPSEEK_API_MODEL` | No | `deepseek-chat` | DeepSeek model to use |
| `exclude` | No | N/A | Comma-separated glob patterns for files to exclude |
| `ALLOWED_USERS` | No | N/A | Comma-separated list of GitHub usernames allowed to trigger manual reviews |
| `STYLE_GUIDE_URL` | No | N/A | URL to a GitHub-hosted style guide for documentation (e.g., https://github.com/pingcap/docs-cn/blob/master/resources/pingcap-style-guide-zh.pdf) |
| `TERMS_GUIDE_URL` | No | N/A | URL to a GitHub-hosted terminology guide for documentation (e.g., https://github.com/pingcap/docs-cn/blob/master/resources/tidb-terms.md) |

## Triggering PR review via PR comments

You can manually trigger document reviews by adding comments to pull requests. This is useful for re-running reviews after making changes or for reviewing specific commits.

### Comment format guidelines

All trigger comments must start with `/bot-review` (with or without a colon).

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

Only users listed in the `ALLOWED_USERS` parameter in the GitHub Action configuration can trigger document reviews.

### Response

After triggering, the bot will:

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
✅ Document review completed! Found 5 issues to address.
```

## Using Style Guides

The AI Doc Reviewer can enforce your organization's documentation standards by referencing style guides and terminology guides.

### Setting up style guides

1. Host your style guides and terminology guides in a GitHub repository. These can be markdown files, PDFs, or other readable formats.

2. Add the URLs to these guides in your workflow configuration:

```yaml
- name: AI Doc Reviewer
  uses: qiancai/ai-doc-reviewer@main
  with:
    # ...other parameters...
    STYLE_GUIDE_URL: "https://github.com/your-org/docs/blob/main/resources/style-guide.md"
    TERMS_GUIDE_URL: "https://github.com/your-org/docs/blob/main/resources/terminology.md"
```

### How it works

When reviewing documentation with style guides enabled:

1. The action fetches the content of the style guides from the provided GitHub URLs
2. The AI reviewer is instructed to follow the guidelines and terminology in these documents
3. Review comments will align with your organization's documentation standards
4. Suggestions will help maintain consistent style, terminology, and formatting

This feature is especially useful for maintaining consistency across large documentation projects with multiple contributors.

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
