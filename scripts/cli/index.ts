import { dispatch } from "./commands.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    await dispatch(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

