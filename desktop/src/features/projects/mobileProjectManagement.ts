import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent, createChannel } from "@/shared/api/tauri";
import {
  getProjectRepoSnapshot,
  getProjectRepoFileContent,
  cloneProjectRepository,
  createProjectRemoteBranch,
  deleteProjectRemoteBranch,
  signProjectPullRequestStatus,
  signProjectIssueAssignment,
  mergeProjectPullRequest,
} from "@/shared/api/projectGit";
import type { MobileScope } from "@/shared/mobile/mobileBridge";
import type { RelayEvent } from "@/shared/api/types";
import { fetchProjects } from "./projectFetch";
import { createProject } from "./createProject";
import {
  buildProjectPatchTemplate,
  buildAddedRepositoryEventTemplatesFromHead,
} from "./projectRepositoryCreation";
import { buildProjectRelatedChannelPatchTemplate } from "./projectChannelCreation";
import { validateProjectEventEnvelope } from "./projectModels";
import {
  fetchProjectIssues,
  fetchProjectPullRequests,
  fetchRepoState,
  createProjectIssueComment,
  createProjectPullRequestComment,
} from "./hooks";
import { buildGitIssueTags } from "./projectIssues.mjs";
import type { Project, Repository } from "./projectModels";
import { projectPullRequestTags } from "./pullRequestMutations";
import { canReviewProjectPullRequest } from "./pullRequestReviews";
import { applyProjectHomeCanvas } from "./lib/projectHomeTemplate";
import {
  PR_APPROVAL_LABEL,
  PR_CHANGES_REQUESTED_LABEL,
} from "./projectPullRequests.mjs";

function text(
  input: Record<string, unknown>,
  key: string,
  max = 256,
  optional = false,
) {
  const value = input[key];
  if (optional && value === undefined) return "";
  if (
    typeof value !== "string" ||
    (!optional && !value.trim()) ||
    new TextEncoder().encode(value).length > max
  )
    throw new Error("invalid_request");
  return value.trim();
}
function view(project: Project) {
  return {
    id: project.id,
    projectAddress: project.projectAddress,
    name: project.name,
    dtag: project.dtag,
    description: project.description,
    owner: project.owner,
    createdAt: project.createdAt,
    channelId: project.projectChannelId,
    relatedChannelIds: project.relatedChannelIds,
    visibility: project.visibility ?? "listed",
    legacy: project.legacy,
    repositories: project.repositories.map((repo) => ({
      repoAddress: repo.repoAddress,
      name: repo.name,
      description: repo.description,
      cloneUrls: repo.cloneUrls,
      defaultBranch: repo.defaultBranch,
      channelId: repo.channelId,
      owner: repo.owner,
    })),
  };
}
async function publish(scope: MobileScope, event: RelayEvent) {
  await scope.assertActive();
  await relayClient.publishEvent(
    event,
    "Mobile project save timed out.",
    "Mobile project save rejected.",
  );
  await scope.assertActive();
}
async function liveProject(
  scope: MobileScope,
  project: Project,
  expected: unknown,
) {
  if (project.legacy || project.owner !== scope.owner)
    throw new Error("owner_required");
  const head = (
    await relayClient.fetchEvents({
      kinds: [30621],
      authors: [scope.owner],
      "#d": [project.dtag],
      limit: 1,
    })
  )[0];
  if (!head) throw new Error("project_unavailable");
  if (expected !== head.id) throw new Error("revision_conflict");
  await scope.assertActive();
  return head;
}
function repository(
  project: Project,
  input: Record<string, unknown>,
): Repository {
  const repo = project.repositories.find(
    (r) => r.repoAddress === input.repoAddress,
  );
  if (!repo) throw new Error("repository_unavailable");
  return repo;
}

/** Mobile project writes use Desktop's signed NIP-MP/NIP-34 templates and live owner heads. */
export async function mobileProjectManagement(
  action: string,
  input: Record<string, unknown>,
  scope: MobileScope,
): Promise<unknown> {
  await scope.assertActive();
  const projects = await fetchProjects();
  await scope.assertActive();
  if (action === "projects.list")
    return {
      projects: projects.slice(0, 50).map(view),
      truncated: projects.length > 50,
    };
  if (action === "projects.create") {
    const result = await createProject(
      {
        name: text(input, "name"),
        description: text(input, "description", 2048, true),
        projectVisibility:
          input.visibility === "unlisted" ? "unlisted" : "listed",
        channelVisibility:
          input.channelVisibility === "private" ? "private" : "open",
      },
      { channels: new Map(), projectIds: new Set() },
    );
    await scope.assertActive();
    const canvasReady = result.channel
      ? await applyProjectHomeCanvas({
          channelId: result.channel.id,
          project: result.project,
        })
      : false;
    return { project: view(result.project), canvasPending: !canvasReady };
  }
  const project = projects.find(
    (p) => p.projectAddress === input.projectAddress,
  );
  if (!project) throw new Error("project_unavailable");
  if (action === "projects.get") {
    const head = (
      await relayClient.fetchEvents({
        kinds: [project.legacy ? 30617 : 30621],
        authors: [project.owner],
        "#d": [project.dtag],
        limit: 1,
      })
    )[0];
    return { project: view(project), revision: head?.id ?? null };
  }
  if (
    [
      "projects.update",
      "projects.attach",
      "projects.detach",
      "projects.add_repository",
      "projects.add_channel",
    ].includes(action)
  ) {
    const head = await liveProject(scope, project, input.expectedRevision);
    let template = {
      kind: 30621,
      content: head.content,
      tags: head.tags.map((tag) => [...tag]),
      createdAt: Math.max(Math.floor(Date.now() / 1000), head.created_at + 1),
    };
    if (action === "projects.update") {
      template.tags = head.tags.filter(
        (tag) => !["name", "description", "buzz-visibility"].includes(tag[0]),
      );
      template.tags.push(["name", text(input, "name")]);
      const description = text(input, "description", 2048, true);
      if (description) template.tags.push(["description", description]);
      if (input.visibility === "unlisted")
        template.tags.push(["buzz-visibility", "unlisted"]);
    } else if (action === "projects.add_channel") {
      await scope.assertActive();
      const channel = await createChannel({
        channelType: "stream",
        name: text(input, "name"),
        description: text(input, "description", 2048, true),
        visibility: input.channelVisibility === "private" ? "private" : "open",
      });
      await scope.assertActive();
      // A channel may exist if the second write conflicts; never claim both writes completed.
      try {
        const refreshed = await liveProject(scope, project, head.id);
        const patch = buildProjectRelatedChannelPatchTemplate({
          channelId: channel.id,
          liveHead: refreshed,
          ownerPubkey: scope.owner,
        });
        template = { ...template, ...patch.project };
      } catch {
        throw new Error("needs_reconcile");
      }
    } else if (action === "projects.add_repository") {
      const cloneUrl = text(input, "cloneUrl", 2048, true);
      if (cloneUrl) {
        const parsed = new URL(cloneUrl);
        if (parsed.origin !== scope.relay || parsed.username || parsed.password)
          throw new Error("community_repository_required");
      }
      const templates = buildAddedRepositoryEventTemplatesFromHead({
        liveHead: head,
        ownerPubkey: scope.owner,
        existingRepositoryAddresses: project.repositoryAddresses,
        accessChannelId: project.projectChannelId ?? undefined,
        name: text(input, "name"),
        description: text(input, "description", 2048, true),
        cloneUrl: cloneUrl || undefined,
      });
      const dtag = templates.repository.tags.find((tag) => tag[0] === "d")?.[1];
      if (
        !dtag ||
        (
          await relayClient.fetchEvents({
            kinds: [30617],
            authors: [scope.owner],
            "#d": [dtag],
            limit: 1,
          })
        ).length
      )
        throw new Error("repository_exists");
      await publish(scope, await signRelayEvent(templates.repository));
      try {
        await liveProject(scope, project, head.id);
      } catch {
        throw new Error("needs_reconcile");
      }
      template = { ...template, ...templates.project };
    } else {
      const address = text(input, "repoAddress", 1200);
      if (!/^30617:[0-9a-f]{64}:.+$/.test(address))
        throw new Error("invalid_request");
      const all = project.repositoryAddresses.filter(
        (value) => value !== address,
      );
      if (action === "projects.attach") {
        const pieces = /^30617:([0-9a-f]{64}):(.+)$/.exec(address);
        if (!pieces) throw new Error("invalid_request");
        const available = await relayClient.fetchEvents({
          kinds: [30617],
          authors: [pieces[1]],
          "#d": [pieces[2]],
          limit: 1,
        });
        if (!available.length) throw new Error("repository_unavailable");
        all.push(address);
      }
      template = {
        ...template,
        ...buildProjectPatchTemplate({
          liveHead: head,
          ownerPubkey: scope.owner,
          repositoryAddresses: all,
        }),
      };
    }
    validateProjectEventEnvelope(template.tags, template.content);
    try {
      await liveProject(scope, project, head.id);
    } catch (error) {
      if (["projects.add_channel", "projects.add_repository"].includes(action))
        throw new Error("needs_reconcile");
      throw error;
    }
    const signed = await signRelayEvent(template);
    await publish(scope, signed);
    return { saved: true, revision: signed.id };
  }
  const repo = repository(project, input);
  if (action === "issues.list")
    return {
      issues: (await fetchProjectIssues(repo)).slice(0, 50).map((issue) => ({
        id: issue.id,
        title: issue.title,
        content: issue.content.slice(0, 4000),
        status: issue.status,
        updatedAt: issue.updatedAt,
        author: issue.author,
        assignees: issue.assignees,
        comments: issue.comments.slice(-10).map((c) => ({
          id: c.id,
          content: c.content.slice(0, 2000),
          author: c.author,
        })),
      })),
    };
  if (action === "issues.create") {
    const category = ["issue", "change-request", "improvement"].includes(
      String(input.category),
    )
      ? (input.category as "issue" | "change-request" | "improvement")
      : "issue";
    const signed = await signRelayEvent({
      kind: 1621,
      content: text(input, "body", 20_000, true),
      tags: buildGitIssueTags({
        repoAddress: repo.repoAddress,
        repoOwner: repo.owner,
        title: text(input, "title"),
        labels: [category],
      }),
    });
    await publish(scope, signed);
    return { id: signed.id };
  }
  if (action === "issues.comment") {
    const issue = (await fetchProjectIssues(repo)).find(
      (issue) => issue.id === input.issueId,
    );
    if (!issue) throw new Error("issue_unavailable");
    await scope.assertActive();
    return {
      id: await createProjectIssueComment({
        project: repo,
        issue,
        content: text(input, "body", 10_000),
      }),
    };
  }
  if (action === "issues.status" || action === "issues.assign") {
    const issue = (await fetchProjectIssues(repo)).find(
      (item) => item.id === input.issueId,
    );
    if (!issue) throw new Error("issue_unavailable");
    if (scope.owner !== repo.owner && scope.owner !== issue.author)
      throw new Error("owner_required");
    if (input.expectedUpdatedAt !== issue.updatedAt)
      throw new Error("revision_conflict");
    await scope.assertActive();
    if (action === "issues.assign") {
      const assignees = text(input, "assignees", 4000)
        .split(/[\s,]+/)
        .filter(Boolean);
      if (
        !assignees.length ||
        assignees.length > 50 ||
        assignees.some((key) => !/^[0-9a-f]{64}$/.test(key))
      )
        throw new Error("invalid_request");
      await signProjectIssueAssignment({
        targetOwner: scope.owner,
        repoAddress: repo.repoAddress,
        issueId: issue.id,
        assignees,
        assigneeLabel: "선택한 에이전트/사용자",
        createdAt: Math.max(Math.floor(Date.now() / 1000), issue.updatedAt + 1),
      });
      return { saved: true };
    }
    const kinds: Record<string, number> = {
      open: 1630,
      resolved: 1631,
      closed: 1632,
      draft: 1633,
    };
    const kind = kinds[text(input, "status")];
    if (!kind) throw new Error("invalid_request");
    const signed = await signRelayEvent({
      kind,
      content: "",
      createdAt: Math.max(Math.floor(Date.now() / 1000), issue.updatedAt + 1),
      tags: [
        ["a", repo.repoAddress],
        ["e", issue.id, "", "root"],
        ["p", repo.owner],
        ["p", issue.author],
      ],
    });
    await publish(scope, signed);
    return { saved: true };
  }
  if (action === "reviews.list")
    return {
      reviews: (await fetchProjectPullRequests(repo))
        .slice(0, 50)
        .map((pr) => ({
          id: pr.id,
          title: pr.title,
          content: pr.content.slice(0, 4000),
          status: pr.status,
          author: pr.author,
          commit: pr.commit,
          branchName: pr.branchName,
          targetBranch: pr.targetBranch,
          reviewers: pr.reviewers,
          approvalCount: pr.approvals.length,
          canReview: canReviewProjectPullRequest(repo, pr, scope.owner),
        })),
    };
  if (action === "reviews.create") {
    const branch = text(input, "branch");
    const targetBranch = text(input, "targetBranch");
    const commit = text(input, "commit", 64);
    if (!/^[0-9a-f]{40,64}$/.test(commit) || branch === targetBranch)
      throw new Error("invalid_request");
    const signed = await signRelayEvent({
      kind: 1618,
      content: text(input, "body", 20_000, true),
      tags: projectPullRequestTags(repo, {
        title: text(input, "title"),
        body: "",
        branch,
        targetBranch,
        commit,
        mergeBase: null,
        reviewers: [],
      }),
    });
    await publish(scope, signed);
    return { id: signed.id };
  }
  if (action === "reviews.decide" || action === "reviews.merge") {
    const pr = (await fetchProjectPullRequests(repo)).find(
      (item) => item.id === input.reviewId,
    );
    if (!pr?.commit || input.expectedCommit !== pr.commit)
      throw new Error("revision_conflict");
    await scope.assertActive();
    if (action === "reviews.decide") {
      if (!canReviewProjectPullRequest(repo, pr, scope.owner))
        throw new Error("review_not_allowed");
      const decision = text(input, "decision");
      if (!["approve", "request-changes"].includes(decision))
        throw new Error("invalid_request");
      const signed = await signRelayEvent({
        kind: 1,
        content:
          text(input, "body", 10_000, true) ||
          (decision === "approve"
            ? "Approved these changes"
            : "Requested changes"),
        createdAt: Math.max(
          Math.floor(Date.now() / 1000),
          ...pr.comments.map((c) => c.createdAt + 1),
        ),
        tags: [
          ["e", pr.id, "", "root"],
          ["a", repo.repoAddress],
          ["p", repo.owner],
          ["p", pr.author],
          [
            "t",
            decision === "approve"
              ? PR_APPROVAL_LABEL
              : PR_CHANGES_REQUESTED_LABEL,
          ],
          ["c", pr.commit],
        ],
      });
      await publish(scope, signed);
      return { saved: true };
    }
    if (
      repo.owner !== scope.owner ||
      !pr.targetBranch ||
      !pr.branchName ||
      pr.status !== "Open"
    )
      throw new Error("owner_required");
    if (input.confirmation !== pr.commit)
      throw new Error("confirmation_required");
    const targetCloneUrl = repo.cloneUrls.find((url) => {
      try {
        return new URL(url).origin === scope.relay;
      } catch {
        return false;
      }
    });
    const sourceCloneUrl = (
      pr.cloneUrls.length ? pr.cloneUrls : repo.cloneUrls
    ).find((url) => {
      try {
        return new URL(url).origin === scope.relay;
      } catch {
        return false;
      }
    });
    if (!targetCloneUrl || !sourceCloneUrl)
      throw new Error("community_repository_required");
    const merged = await mergeProjectPullRequest({
      targetCloneUrl,
      sourceCloneUrl,
      targetOwner: repo.owner,
      repoAddress: repo.repoAddress,
      pullRequestId: pr.id,
      pullRequestAuthor: pr.author,
      statusCreatedAt: Math.max(
        Math.floor(Date.now() / 1000),
        (pr.statusCreatedAt ?? 0) + 1,
      ),
      targetBranch: pr.targetBranch,
      sourceBranch: pr.branchName,
      expectedCommit: pr.commit,
    });
    return {
      mergeCommit: merged.mergeCommit,
      statusPublicationPending: !!merged.statusPublicationError,
    };
  }
  if (action === "reviews.comment" || action === "reviews.status") {
    const pr = (await fetchProjectPullRequests(repo)).find(
      (pr) => pr.id === input.reviewId,
    );
    if (!pr) throw new Error("review_unavailable");
    await scope.assertActive();
    if (action === "reviews.comment")
      return {
        id: await createProjectPullRequestComment({
          project: repo,
          pullRequest: pr,
          content: text(input, "body", 10_000),
        }),
      };
    if (scope.owner !== repo.owner && scope.owner !== pr.author)
      throw new Error("owner_required");
    if (input.expectedCommit !== pr.commit)
      throw new Error("revision_conflict");
    const status = text(input, "status");
    if (!["open", "draft", "closed"].includes(status))
      throw new Error("invalid_request");
    await signProjectPullRequestStatus({
      targetOwner: scope.owner,
      repoAddress: repo.repoAddress,
      pullRequestId: pr.id,
      pullRequestAuthor: pr.author,
      status: status as "open" | "draft" | "closed",
      createdAt: Math.max(
        Math.floor(Date.now() / 1000),
        (pr.statusCreatedAt ?? 0) + 1,
      ),
    });
    return { saved: true };
  }
  const cloneUrl = repo.cloneUrls.find((url) => {
    try {
      return new URL(url).origin === scope.relay;
    } catch {
      return false;
    }
  });
  if (!cloneUrl) throw new Error("community_repository_required");
  if (action === "repositories.snapshot") {
    const snapshot = await getProjectRepoSnapshot({
      cloneUrl,
      defaultBranch: repo.defaultBranch,
    });
    return {
      commits: snapshot.commits?.slice(0, 15),
      files: snapshot.files
        .slice(0, 150)
        .map((f) => ({ path: f.path, kind: f.kind, size: f.size })),
      latestCommit: snapshot.latestCommit,
      branches: (await fetchRepoState(repo))?.branches ?? [],
    };
  }
  if (action === "repositories.file") {
    const path = text(input, "path", 1024);
    if (path.startsWith("/") || path.split(/[\\/]/).includes(".."))
      throw new Error("invalid_request");
    const content = await getProjectRepoFileContent({
      cloneUrl,
      defaultBranch: repo.defaultBranch,
      path,
    });
    return {
      content: content?.slice(0, 30_000) ?? null,
      truncated: (content?.length ?? 0) > 30_000,
    };
  }
  if (repo.owner !== scope.owner) throw new Error("owner_required");
  await scope.assertActive();
  if (action === "repositories.clone") {
    const cloned = await cloneProjectRepository({
      projectDtag: project.dtag,
      cloneUrl,
      defaultBranch: repo.defaultBranch,
    });
    return { cloned: !!cloned }; // Native local paths stay on the PC.
  }
  const branch = text(input, "branch");
  if (action === "repositories.create_branch")
    return createProjectRemoteBranch({
      cloneUrl,
      sourceBranch: text(input, "sourceBranch"),
      expectedCommit: text(input, "expectedCommit", 64),
      newBranch: branch,
    });
  if (action === "repositories.delete_branch") {
    if (input.confirmation !== branch) throw new Error("confirmation_required");
    return deleteProjectRemoteBranch({
      cloneUrl,
      branch,
      expectedCommit: text(input, "expectedCommit", 64),
    });
  }
  throw new Error("action_unavailable");
}
