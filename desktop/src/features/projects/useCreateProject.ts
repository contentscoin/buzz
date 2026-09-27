import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  channelsQueryKey,
  upsertCachedChannel,
} from "@/features/channels/hooks";
import { useApplyTemplate } from "@/features/channel-templates/useApplyTemplate";
import { useCommunities } from "@/features/communities/useCommunities";
import { type Project, projectsQueryKey } from "@/features/projects/hooks";
import {
  createProject,
  type CreateProjectInput,
  type CreateProjectResult,
  type CreateProjectResumeState,
} from "@/features/projects/createProject";
import { addProjectToSidebar } from "@/features/projects/lib/projectSidebarMembership";
import {
  applyProjectHomeCanvas,
  PROJECT_HOME_TEMPLATE_ID,
} from "@/features/projects/lib/projectHomeTemplate";
import { markProjectDataAuthoritative } from "@/features/projects/projectSnapshot";
import type { Channel } from "@/shared/api/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type { CreateProjectInput, CreateProjectResult };

/** Mutation that creates a project home and inserts it into the caches. */
export function useCreateProjectMutation() {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const { applyAgents, applyCanvas } = useApplyTemplate();
  const resumeRef = React.useRef<CreateProjectResumeState>({
    channels: new Map(),
    projectIds: new Set(),
  });

  return useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const expectedRelayUrl = activeCommunity?.relayUrl?.trim()
        ? activeCommunity.relayUrl
        : undefined;
      const expectedSignerPubkey =
        normalizePubkey(identityQuery.data?.pubkey ?? "") || undefined;
      if (
        input.agents?.length &&
        (!expectedRelayUrl || !expectedSignerPubkey)
      ) {
        throw new Error(
          "Buzz is still connecting to this community. Try creating the project again in a moment.",
        );
      }
      const result = await createProject(
        {
          ...input,
          agents: input.agents?.map((agent) => ({
            ...agent,
            expectedRelayUrl: agent.expectedRelayUrl ?? expectedRelayUrl,
            expectedSignerPubkey:
              agent.expectedSignerPubkey ?? expectedSignerPubkey,
          })),
        },
        resumeRef.current,
      );
      return {
        ...result,
        commandScope: { expectedRelayUrl, expectedSignerPubkey },
      };
    },
    onSuccess: async ({ channel, project, commandScope }, input) => {
      markProjectDataAuthoritative(project, "local-write");
      addProjectToSidebar(
        project.projectAddress,
        getCachedRelayOrigin(),
        project.owner,
      );
      queryClient.setQueryData<Project[]>(projectsQueryKey, (current = []) => [
        project,
        ...current.filter(
          (candidate) =>
            candidate.id !== project.id &&
            !(
              candidate.legacy &&
              candidate.owner === project.owner &&
              candidate.dtag === project.dtag
            ),
        ),
      ]);
      if (channel) {
        queryClient.setQueryData(
          channelsQueryKey,
          (current: Channel[] | undefined) =>
            upsertCachedChannel(current, channel),
        );
        void queryClient.invalidateQueries({
          queryKey: channelsQueryKey,
          refetchType: "none",
        });
        const useProjectHomeTemplate =
          input.templateId === undefined ||
          input.templateId === PROJECT_HOME_TEMPLATE_ID;
        if (useProjectHomeTemplate) {
          const applied = await applyProjectHomeCanvas({
            channelId: channel.id,
            project,
          });
          if (!applied) {
            toast.warning(
              "Project created, but its project-home canvas could not be added.",
            );
          }
        } else if (input.templateId) {
          await Promise.all([
            applyCanvas(input.templateId, channel.id, channel.name),
            applyAgents(input.templateId, channel.id, commandScope),
          ]);
        }
      }
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}
