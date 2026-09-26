import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";

const FmgDashboard = React.lazy(async () => {
  const module = await import("@/features/fmg/ui/FmgDashboard");
  return { default: module.FmgDashboard };
});

export const Route = createFileRoute("/fmg")({
  component: FmgRouteComponent,
});

function FmgRouteComponent() {
  return (
    <React.Suspense
      fallback={<BuzzLoadingState fill label="FMG 센터 불러오는 중" />}
    >
      <FmgDashboard />
    </React.Suspense>
  );
}
