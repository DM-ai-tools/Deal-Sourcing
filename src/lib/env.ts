/**
 * Environment. Lazy getters throughout, so importing this module never throws
 * and a missing variable surfaces as a readable message at the point of use
 * rather than as a container that dies during boot.
 */
import 'dotenv/config';

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  get databaseUrl(): string {
    const value = process.env.DATABASE_URL?.trim();
    if (!value) {
      throw new Error(
        'DATABASE_URL is not set. Add a Postgres database to the Railway project and set ' +
          'DATABASE_URL to ${{Postgres.DATABASE_URL}} on this service.',
      );
    }
    return value;
  },

  get firecrawlKey(): string | null {
    return process.env.FIRECRAWL_API_KEY?.trim() || null;
  },

  get port(): number {
    return num('PORT', 3000);
  },

  get transport(): string {
    return optional('TRANSPORT', 'firecrawl');
  },

  /**
   * Headed browsers are more likely to survive bot detection, but a container
   * has no display. Set BROWSER_HEADLESS=false only where one exists.
   */
  get headlessBrowser(): boolean {
    return optional('BROWSER_HEADLESS', 'true') !== 'false';
  },

  get nodeEnv(): string {
    return optional('NODE_ENV', 'development');
  },
};

/** Non-throwing report, for the health endpoint and the boot banner. */
export function envProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.DATABASE_URL?.trim()) problems.push('DATABASE_URL is not set');
  if (!process.env.FIRECRAWL_API_KEY?.trim()) {
    problems.push('FIRECRAWL_API_KEY is not set — the firecrawl transport will not work');
  }
  return problems;
}
