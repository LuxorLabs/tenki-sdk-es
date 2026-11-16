/** A Linux x64 runner size a Luxor CI job can run on. */
export interface CIRunnerSize {
  runsOnLabel: string;
  cpu: number;
  memoryGiB: number;
}

/** The sizes Luxor CI can run for a workspace, within its job-size limits, smallest first. */
export interface CIRunnerSizes {
  sizes: CIRunnerSize[];
  /** The size for a job whose runs-on names none. */
  defaultRunsOnLabel: string;
}
