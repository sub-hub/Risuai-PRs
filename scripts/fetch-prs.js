require("dotenv").config();
const { Octokit } = require("@octokit/rest");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const OUTPUT_PATH = path.join(__dirname, "..", "data.json");

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error("GH_TOKEN environment variable is not set");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const repos = config.repositories;

  const octokit = new Octokit({ auth: token });

  const allPRs = [];
  const errors = [];

  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split("/");
    console.log(`Fetching PRs for ${owner}/${repo}...`);

    try {
      // Fetch open PRs
      const { data: pulls } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 100,
      });

      console.log(`  Found ${pulls.length} open PR(s)`);

      for (const pr of pulls) {
        try {
          // Fetch PR detail (additions, deletions, draft) and reviews in parallel
          const [detailResult, reviewsResult] = await Promise.allSettled([
            octokit.rest.pulls.get({ owner, repo, pull_number: pr.number }),
            octokit.rest.pulls.listReviews({ owner, repo, pull_number: pr.number, per_page: 100 }),
          ]);

          const prDetail = detailResult.status === "fulfilled" ? detailResult.value.data : null;
          const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value.data : [];

          // Deduplicate: keep only the latest review per reviewer
          const latestByReviewer = new Map();
          for (const r of reviews) {
            const reviewer = r.user?.login || "unknown";
            const existing = latestByReviewer.get(reviewer);
            if (!existing || new Date(r.submitted_at) > new Date(existing.submitted_at)) {
              latestByReviewer.set(reviewer, {
                reviewer,
                state: r.state, // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
                submitted_at: r.submitted_at,
                author_association: r.author_association, // COLLABORATOR, MEMBER, OWNER, CONTRIBUTOR, NONE
              });
            }
          }
          const reviewData = Array.from(latestByReviewer.values());

          allPRs.push({
            repository: repoFullName,
            pr_number: pr.number,
            title: pr.title,
            body: pr.body || "",
            url: pr.html_url,
            author: pr.user?.login || "unknown",
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            labels: pr.labels.map((l) => l.name),
            draft: prDetail?.draft ?? pr.draft ?? false,
            additions: prDetail?.additions ?? 0,
            deletions: prDetail?.deletions ?? 0,
            reviews: reviewData,
          });
        } catch (prErr) {
          console.error(`  Failed to fetch reviews for PR #${pr.number}: ${prErr.message}`);
          errors.push({
            repository: repoFullName,
            pr_number: pr.number,
            error: prErr.message,
          });
        }
      }
    } catch (repoErr) {
      console.error(`  Failed to fetch PRs for ${repoFullName}: ${repoErr.message}`);
      errors.push({
        repository: repoFullName,
        error: repoErr.message,
      });
    }
  }

  const output = {
    last_updated: new Date().toISOString(),
    status: errors.length > 0 ? "partial" : "ok",
    total_count: allPRs.length,
    prs: allPRs,
    errors: errors,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\nDone. ${allPRs.length} PR(s) written to data.json`);
  if (errors.length > 0) {
    console.log(`${errors.length} error(s) occurred.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);

  // On fatal error, don't overwrite existing data.json — write stale status instead
  const existingPath = path.join(__dirname, "..", "data.json");
  if (fs.existsSync(existingPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingPath, "utf-8"));
      existing.status = "stale";
      existing.last_updated = new Date().toISOString();
      fs.writeFileSync(existingPath, JSON.stringify(existing, null, 2), "utf-8");
      console.log("Previous data.json kept with status=stale");
    } catch (_) {
      // If we can't read existing, write a minimal error file
      fs.writeFileSync(
        existingPath,
        JSON.stringify(
          {
            last_updated: new Date().toISOString(),
            status: "error",
            total_count: 0,
            prs: [],
            errors: [{ error: err.message }],
          },
          null,
          2
        ),
        "utf-8"
      );
    }
  }

  process.exit(1);
});
