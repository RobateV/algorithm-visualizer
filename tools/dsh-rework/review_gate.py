#!/usr/bin/env python3
"""Validate a human-account ChatGPT review signal before any DSH model call.

This runs in a read-only GitHub Actions job, on trusted main, without model secrets.
Only an exact same-SHA review request for one existing lesson HTML is eligible.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPO = "RobateV/algorithm-visualizer"
REVIEW_AUTHOR = "RobateV"
INITIAL_REVIEW_ID = 6870077607  # Previously verified Work review on PR #19.
MAX_REWORKS = 2  # 1 original PR commit + at most 2 fixing commits.
REWORK_MARKER = re.compile(r"^<!-- dsh-action:rework:([1-9]\d*):([a-f0-9]{40}) -->\n")
FILE_PATTERN = re.compile(r"public/lessons/[A-Za-z0-9][A-Za-z0-9._-]*\.html\Z")
BRANCH_PATTERN = re.compile(r"lesson/dsh-[a-z0-9][a-z0-9._-]{1,100}\Z")


def reject(why):
    raise SystemExit("REWORK REJECTED: " + why)


def gh_json(path):
    result = subprocess.run(
        ["gh", "api", f"repos/{REPO}/{path}"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        reject("GitHub read failed for " + path.split("?")[0])
    try:
        return json.loads(result.stdout)
    except ValueError:
        reject("GitHub returned invalid JSON")


def has_issue(body):
    return re.search(r"\[P[012]\]", body) is not None


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if event.get("action") != "created":
        reject("Not a newly created comment")
    if event.get("repository", {}).get("full_name") != REPO:
        reject("Wrong repository")

    comment = event.get("comment") or {}
    issue = event.get("issue") or {}
    body = comment.get("body", "")
    if not isinstance(body, str) or len(body) > 16000:
        reject("Unexpected review comment size")
    if comment.get("user", {}).get("login") != REVIEW_AUTHOR:
        reject("Comment author is not the authorized GitHub account")
    if os.environ.get("GITHUB_ACTOR") != REVIEW_AUTHOR:
        reject("GitHub event actor is not the authorized account")
    if not issue.get("pull_request"):
        reject("Comment did not target a pull request")
    marker = REWORK_MARKER.match(body)
    if marker is None:
        reject("Missing exact rework marker at the beginning of the comment")
    number, review_sha = int(marker.group(1)), marker.group(2)
    if number != issue.get("number"):
        reject("Marker references another PR")
    if body.count("<!-- dsh-action:rework:") != 1:
        reject("Ambiguous rework markers")

    pr = gh_json(f"pulls/{number}")
    if pr.get("state") != "open" or not pr.get("draft") or pr.get("merged"):
        reject("Only an open, unmerged draft PR may be auto-fixed")
    if pr.get("user", {}).get("login") != "github-actions[bot]":
        reject("PR is not an automated DSH PR")
    if pr.get("base", {}).get("ref") != "main":
        reject("PR does not target main")
    head = pr.get("head", {})
    branch = head.get("ref", "")
    if not BRANCH_PATTERN.fullmatch(branch):
        reject("PR branch is not an approved DSH lesson branch")
    if (head.get("repo") or {}).get("full_name") != REPO:
        reject("PR branch is from another repository")
    if head.get("sha") != review_sha:
        reject("The PR has changed since the review")
    commits = pr.get("commits", 0)
    if not isinstance(commits, int) or not 1 <= commits <= MAX_REWORKS:
        reject("Per-PR rework budget exhausted or invalid")

    files = gh_json(f"pulls/{number}/files?per_page=100")
    if pr.get("changed_files") != 1 or len(files) != 1:
        reject("Pilot supports only one changed lesson file")
    target = files[0].get("filename", "")
    if files[0].get("status") != "modified" or not FILE_PATTERN.fullmatch(target):
        reject("Changed file is outside the one-file lesson allowlist")
    if not has_issue(body):
        reject("No concrete P0/P1/P2 review issue supplied")

    auto_marker = f"<!-- dsh-chatgpt-review:{number}:{review_sha} -->"
    if auto_marker in body:
        if body.count(auto_marker) != 1:
            reject("Ambiguous ChatGPT review marker")
        if "<!-- dsh-source-review:" in body:
            reject("Automated review cannot also supply a source review ID")
        instructions = body
    else:
        # One carefully scoped bootstrap of the previously posted Work review,
        # which predates the new machine-readable ChatGPT review marker.
        source_marker = re.search(r"<!-- dsh-source-review:(\d+) -->", body)
        if (number != 19 or source_marker is None
                or int(source_marker.group(1)) != INITIAL_REVIEW_ID):
            reject("No matching ChatGPT review marker or approved initial Work review")
        prior = gh_json(f"issues/comments/{INITIAL_REVIEW_ID}")
        required = f"<!-- work-review:{REPO}:19:{review_sha} -->"
        if (prior.get("user", {}).get("login") != REVIEW_AUTHOR
                or not prior.get("issue_url", "").endswith("/issues/19")
                or required not in prior.get("body", "")
                or not has_issue(prior.get("body", ""))):
            reject("Original Work review cannot be verified for this SHA")
        instructions = prior["body"] + "\n\nRework request:\n" + body

    # Keep the payload separate from shell commands and from the publishing job.
    request_dir = Path("review-payload")
    request_dir.mkdir(exist_ok=True)
    (request_dir / "review.txt").write_text(instructions, encoding="utf-8")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for key, value in (
            ("pr", str(number)),
            ("head", review_sha),
            ("branch", branch),
            ("path", target),
            ("comment_id", str(comment.get("id"))),
        ):
            output.write(f"{key}={value}\n")
    print(f"Authorized PR #{number} @ {review_sha[:12]}; next fix {commits}/{MAX_REWORKS + 1} commits; path {target}")


if __name__ == "__main__":
    main()
