export class AcceptedWorkspacePublicationIndeterminateError extends Error {
  override name = "AcceptedWorkspacePublicationIndeterminateError";
  readonly observationFailure!: unknown;

  constructor(
    readonly operation: "apply" | "commit",
    publicationFailure: unknown,
    observationFailure: unknown,
  ) {
    super("Accepted workspace publication is indeterminate and requires recovery", {
      cause: publicationFailure,
    });
    Object.defineProperty(this, "observationFailure", { value: observationFailure });
  }
}
