export const guideStart = "<!-- FMG_BUZZ_PROJECT_START -->";
export const guideEnd = "<!-- FMG_BUZZ_PROJECT_END -->";

/** Put the exact Buzz routing rule before legacy role guidance, preserving its text. */
export function buzzProjectGuidance(text, roleId, worktree, branch) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 524288 ||
    !/^(main|fmg-(planner|frontend|backend|qa|release))$/.test(roleId) ||
    worktree !== `/data/.openclaw/workspaces/${roleId}/projects/buzz` ||
    branch !== `fmg-buzz/${roleId}`) throw new Error("buzz_guide_binding_invalid");
  const count = (marker) => text.split(marker).length - 1;
  if (count(guideStart) !== count(guideEnd) || count(guideStart) > 1)
    throw new Error("guide_markers_invalid");
  let existing = text;
  if (text.includes(guideStart)) {
    const start = text.indexOf(guideStart), end = text.indexOf(guideEnd);
    if (end <= start) throw new Error("guide_markers_invalid");
    existing = text.slice(0, start) + text.slice(end + guideEnd.length);
  }
  const block = `${guideStart}\n### FMG Buzz 저장소 작업 경로\n\nBuzz 저장소 작업을 받으면 먼저 ${worktree.replace('/projects/buzz', '/BUZZ_PROJECT.md')}를 읽는다.\n이 작업의 코드 디렉터리: ${worktree}\n이 작업의 브랜치: ${branch}\nBuzz 작업에는 이 경로 안내를 적용한다. 아래 일반 역할 안내의 저장소 경로는 해당 일반 프로젝트 작업에 적용한다.\nGit 조회는 git -C ${worktree} 명령으로 실행하며, 파일 읽기와 exec의 workdir도 이 코드 디렉터리를 명시한다.\n작업의 저장소·브랜치·기준 HEAD가 제안과 일치하는지 먼저 확인하고, 다르면 실제 값을 보고하고 멈춘다.\n이 안내는 실행 승인이나 작업 완료 근거가 아니다. 실제 소유자 허용과 도구 권한 및 작업 지시 범위를 따른다.\n${guideEnd}`;
  const result = `${block}\n\n${existing.replace(/^\s*\n/, '').trimEnd()}\n`;
  if (Buffer.byteLength(result) > 524288) throw new Error("guide_file_limit");
  return result;
}
