export class EnvConfig {
  constructor(private readonly values: NodeJS.ProcessEnv = process.env) {}

  get<T extends string | number = string>(key: string): T | undefined {
    const value = this.values[key];
    if (value === undefined) return undefined;
    return value as T;
  }

  getNumber(key: string, defaultValue: number): number {
    const value = this.values[key];
    if (value === undefined || value === '') return defaultValue;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }

  getBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.values[key];
    if (value === undefined || value === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
}
