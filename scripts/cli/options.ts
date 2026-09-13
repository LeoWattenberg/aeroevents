export interface ParsedOptions {
  positional: string[];
  values: Map<string, string | true>;
}

export function parseOptions(args: string[]): ParsedOptions {
  const positional: string[] = [];
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    if (separator !== -1) {
      values.set(argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const key = argument.slice(2);
    const following = args[index + 1];
    if (following && !following.startsWith("--")) {
      values.set(key, following);
      index += 1;
    } else {
      values.set(key, true);
    }
  }
  return { positional, values };
}

export function stringOption(options: ParsedOptions, name: string): string | undefined {
  const value = options.values.get(name);
  return typeof value === "string" ? value : undefined;
}

export function booleanOption(options: ParsedOptions, name: string): boolean {
  return options.values.get(name) === true;
}

