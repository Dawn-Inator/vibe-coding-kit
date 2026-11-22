export const OPTIONAL_GROUPS: readonly ['aliyun', 'lark', 'non-code', 'app-store-compliance'];
export function validateOptionalPreferences(value: unknown): void;
export function readOptionalGroupPreference(projectRoot: string, group: string): boolean | undefined;
