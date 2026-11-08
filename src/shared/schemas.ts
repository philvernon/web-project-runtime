import { z } from "zod";

/** Public immutable artifact reference, never source or dependency/capability authority.
 * Object parsing deliberately strips historical runtime metadata in retained chats;
 * old references expire normally and do not resurrect retired execution paths. */
export const artifactSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  source: z.enum(["model", "test-fixture"]),
  frameUrl: z.string(),
});
export type ArtifactReference = z.infer<typeof artifactSchema>;
