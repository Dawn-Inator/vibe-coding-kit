export const OPTIONAL_GROUPS: readonly ['aliyun', 'lark', 'non-code', 'task-progress'];
export function validateOptionalPreferences(value: unknown): void;
export function readOptionalGroupPreference(projectRoot: string, group: string): boolean | undefined;
