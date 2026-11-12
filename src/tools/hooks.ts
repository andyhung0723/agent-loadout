import type { HookResource, Tool } from '../manifest.ts';
import { withoutUndefined, type Plain } from '../values.ts';

/** Claude and Codex share the hook group shape: { matcher, hooks: [{ type, command, timeout }] }. */
export function hookGroup(resource: HookResource, tool: Tool): Plain {
  const spec = { ...resource.spec, ...resource.overrides[tool] };
  return withoutUndefined({
    matcher: spec.matcher,
    hooks: [
      withoutUndefined({
        type: 'command',
        command: spec.command,
        timeout: spec.timeout,
      }),
    ],
  });
}
