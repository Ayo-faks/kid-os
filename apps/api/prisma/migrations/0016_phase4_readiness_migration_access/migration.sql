-- The API readiness probe verifies that every shipped Prisma migration has
-- finished. The application role only needs read access to migration metadata;
-- schema changes remain restricted to the owner role used by `prisma migrate`.

GRANT SELECT ON TABLE "public"."_prisma_migrations" TO "careos_app";
