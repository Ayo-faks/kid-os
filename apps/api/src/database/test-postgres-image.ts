export const CAREOS_TEST_POSTGRES_IMAGE =
  'pgvector/pgvector:pg16@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b';

export function resolveCareosTestPostgresImage(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CAREOS_TEST_POSTGRES_IMAGE ?? CAREOS_TEST_POSTGRES_IMAGE;
  if (configured !== CAREOS_TEST_POSTGRES_IMAGE) {
    throw new Error(
      'CAREOS_TEST_POSTGRES_IMAGE must equal the reviewed digest-pinned pgvector image.',
    );
  }
  return configured;
}
