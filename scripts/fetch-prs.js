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
  let freshRepos = 0;

  // Load previous data.json for graceful degradation: if a repo fetch fails
  // (e.g. expired token, rate limit), keep that repo's previously fetched PRs
  // instead of wiping the dashboard with empty data.
  const previousByRepo = new Map();
  try {
    if (fs.existsSync(OUTPUT_PATH)) {
      const previous = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8"));
      if (Array.isArray(previous.prs)) {
        for (const p of previous.prs) {
          if (!previousByRepo.has(p.repository)) previousByRepo.set(p.repository, []);
          previousByRepo.get(p.repository).push(p);
        }
      }
    }
  } catch (prevErr) {
    console.warn(`Could not read previous data.json: ${prevErr.message}`);
  }

  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split("/");
    console.log(`Fetching PRs for ${owner}/${repo}...`);

    try {
      // Fetch open PRs
      const pulls = await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });
      freshRepos += 1;

      console.log(`  Found ${pulls.length} open PR(s)`);

      for (const pr of pulls) {
        try {
          // Fetch PR detail (additions, deletions, draft) and reviews in parallel
          const [detailResult, reviewsResult] = await Promise.allSettled([
            octokit.rest.pulls.get({ owner, repo, pull_number: pr.number }),
            octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 }),
          ]);

          const prDetail = detailResult.status === "fulfilled" ? detailResult.value.data : null;
          const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value : [];

          // Deduplicate: keep only the latest review per reviewer. A later COMMENTED
          // review does not replace an APPROVED/CHANGES_REQUESTED/DISMISSED one,
          // matching how GitHub keeps the approval in place.
          const latestByReviewer = new Map();
          for (const r of reviews) {
            if (r.state === "PENDING") continue;
            const reviewer = r.user?.login || "unknown";
            const existing = latestByReviewer.get(reviewer);
            const newer = !existing || new Date(r.submitted_at) > new Date(existing.submitted_at);
            const keepsVerdict = existing && existing.state !== "COMMENTED" && r.state === "COMMENTED";
            if (newer && !keepsVerdict) {
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
          // Keep the previously fetched entry for this PR if available.
          const old = (previousByRepo.get(repoFullName) || []).find((p) => p.pr_number === pr.number);
          if (old) allPRs.push(old);
        }
      }
    } catch (repoErr) {
      console.error(`  Failed to fetch PRs for ${repoFullName}: ${repoErr.message}`);
      errors.push({
        repository: repoFullName,
        error: repoErr.message,
      });
      // Graceful degradation: keep this repo's previously fetched PRs.
      const stale = previousByRepo.get(repoFullName) || [];
      if (stale.length > 0) {
        console.log(`  Keeping ${stale.length} previously fetched PR(s) for ${repoFullName}`);
        allPRs.push(...stale);
      }
    }
  }

  // status: "ok" = all fresh, "partial" = some repos failed (old data kept for those),
  // "stale" = every repo fetch failed, data is entirely from the previous run.
  const status = errors.length === 0 ? "ok" : freshRepos === 0 ? "stale" : "partial";

  const output = {
    last_updated: new Date().toISOString(),
    status,
    total_count: allPRs.length,
    prs: allPRs,
    errors: errors,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\nDone. ${allPRs.length} PR(s) written to data.json (status=${status})`);
  if (errors.length > 0) {
    console.log(`${errors.length} error(s) occurred.`);
    if (freshRepos === 0) {
      console.log("All repo fetches failed — previous data kept with status=stale.");
    }
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
