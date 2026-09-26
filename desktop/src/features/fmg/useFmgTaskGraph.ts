import * as React from "react";

import {
  type Project,
  type ProjectIssue,
  type ProjectIssueListItem,
  useProjectsQuery,
  useProjectsWorkItemsQuery,
} from "@/features/projects/hooks";
import {
  projectsWithWorkItemRepositories,
  type ProjectWorkItemSection,
} from "@/features/projects/projectWorkItems";

const GRAPH_LABEL = "graph";
const EVENT_ID_PATTERN = /^[a-fA-F0-9]{64}$/;
const EMPTY_PROJECTS: Project[] = [];
const EMPTY_FAILED_SECTIONS: ProjectWorkItemSection[] = [];

/** A dependency edge with enough identity to open its issue when it is loaded. */
export type FmgTaskGraphDependency = Readonly<{
  issueId: string;
  projectId: string | null;
  repositoryId: string | null;
  title: string | null;
  /** NIP-34 issue status; null when the target or status data is unavailable. */
  status: ProjectIssue["status"] | null;
}>;

/** Read-only graph task summary consumed by the FMG dashboard. */
export type FmgTaskGraphItem = Readonly<{
  projectId: string;
  projectName: string;
  repositoryId: string;
  repositoryName: string;
  issueId: string;
  title: string;
  /** NIP-34 issue status; null when status data could not be loaded. */
  status: ProjectIssue["status"] | null;
  updatedAt: number;
  dependencyIds: readonly string[];
  invalidDependencyValues: readonly string[];
  dependencies: readonly FmgTaskGraphDependency[];
}>;

function buildTaskGraphItems(
  issueItems: readonly ProjectIssueListItem[],
  statusesAvailable: boolean,
): readonly FmgTaskGraphItem[] {
  const issuesByRepository = new Map<
    string,
    Map<string, ProjectIssueListItem>
  >();
  for (const item of issueItems) {
    const issuesById =
      issuesByRepository.get(item.repository.repoAddress) ??
      new Map<string, ProjectIssueListItem>();
    issuesById.set(item.issue.id.toLowerCase(), item);
    issuesByRepository.set(item.repository.repoAddress, issuesById);
  }

  return issueItems
    .filter(({ issue }) =>
      issue.labels.some((label) => label.toLowerCase() === GRAPH_LABEL),
    )
    .map(({ issue, project, repository }) => {
      const dependencyIds = [
        ...new Set(
          issue.dependencies
            .filter((value) => EVENT_ID_PATTERN.test(value))
            .map((value) => value.toLowerCase()),
        ),
      ];
      const invalidDependencyValues = issue.dependencies.filter(
        (value) => !EVENT_ID_PATTERN.test(value),
      );
      const dependencies = dependencyIds.map((issueId) => {
        const target = issuesByRepository
          .get(repository.repoAddress)
          ?.get(issueId);
        return {
          issueId,
          projectId: target?.project.id ?? null,
          repositoryId: target?.repository.id ?? null,
          title: target?.issue.title ?? null,
          status: statusesAvailable ? (target?.issue.status ?? null) : null,
        } satisfies FmgTaskGraphDependency;
      });

      return {
        projectId: project.id,
        projectName: project.name,
        repositoryId: repository.id,
        repositoryName: repository.name,
        issueId: issue.id,
        title: issue.title,
        status: statusesAvailable ? issue.status : null,
        updatedAt: issue.updatedAt,
        dependencyIds,
        invalidDependencyValues,
        dependencies,
      } satisfies FmgTaskGraphItem;
    });
}

/**
 * Loads the existing Projects issue read model and selects graph-labelled tasks
 * for the FMG dashboard. This read-only preview leaves causal transition and
 * dependency-cycle validation to the Buzz CLI.
 */
export function useFmgTaskGraph() {
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const projectsWithRepositories = React.useMemo(
    () => projectsWithWorkItemRepositories(projects),
    [projects],
  );
  const workItemsQuery = useProjectsWorkItemsQuery(projectsWithRepositories);
  const issueItems = workItemsQuery.data?.issues.items;
  const failedSections =
    workItemsQuery.data?.issues.failedSections ?? EMPTY_FAILED_SECTIONS;
  const statusesAvailable = !failedSections.includes("statuses");
  const items = React.useMemo(
    () => buildTaskGraphItems(issueItems ?? [], statusesAvailable),
    [issueItems, statusesAvailable],
  );

  return {
    error: projectsQuery.error ?? workItemsQuery.error,
    failedSections,
    isFetching: projectsQuery.isFetching || workItemsQuery.isFetching,
    isLoading: projectsQuery.isLoading || workItemsQuery.isLoading,
    items,
    projectsQuery,
    workItemsQuery,
  };
}

/** Public result contract for FMG dashboard consumers. */
export type UseFmgTaskGraphResult = ReturnType<typeof useFmgTaskGraph>;
