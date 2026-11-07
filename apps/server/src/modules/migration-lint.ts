/**
 * Module migrations may only create and change objects with the module's own
 * prefix (Technical Architecture §6: "it must not modify core or other
 * modules' tables"). References to core tables (e.g. a foreign key to
 * devices) and core trigger functions (master_before_write) are allowed;
 * writing to them is not.
 */
export function lintModuleSql(sql: string, prefix: string): string[] {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const problems: string[] = [];
  const own = (name: string) => name.toLowerCase().startsWith(prefix);
  const check = (re: RegExp, what: string, group = 1) => {
    for (const m of text.matchAll(re)) {
      const name = m[group];
      if (name.includes('.'))
        problems.push(
          `${what} ${name}: schema-qualified names are not allowed`,
        );
      else if (!own(name))
        problems.push(`${what} ${name}: must start with "${prefix}"`);
    }
  };
  check(
    /\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|SEQUENCE|VIEW|TRIGGER|FUNCTION|TYPE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?("?[A-Za-z_][\w.]*"?)/gi,
    'Object',
  );
  check(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([A-Za-z_][\w.]*)/gi,
    'Index on',
  );
  check(
    /\bCREATE\s+TRIGGER\s+\S+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+[A-Za-z\s,]+?\s+ON\s+([A-Za-z_][\w.]*)/gi,
    'Trigger on',
  );
  check(
    /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+([A-Za-z_][\w.]*)/gi,
    'Write to',
  );
  // UPDATE as a statement — not "DO UPDATE SET", "INSERT OR UPDATE ON", "FOR UPDATE".
  check(
    /(?<!\b(?:DO|OR|FOR)\s+)\bUPDATE\s+(?!(?:SET|OR|ON|OF|NOWAIT|SKIP)\b)([A-Za-z_][\w.]*)/gi,
    'Write to',
  );
  for (const [re, what] of [
    [/\b(GRANT|REVOKE)\b/i, 'GRANT/REVOKE'],
    [
      /\bCREATE\s+(ROLE|USER|SCHEMA|EXTENSION|DATABASE)\b/i,
      'Creating roles, schemas, extensions or databases',
    ],
    [
      /\bSET\s+(?:LOCAL\s+)?(search_path|role|session_authorization)\b/i,
      'Changing search_path or role',
    ],
    [
      /\bALTER\s+(SYSTEM|ROLE|USER|DATABASE|SCHEMA)\b/i,
      'Altering system objects',
    ],
    [/\bSECURITY\s+DEFINER\b/i, 'SECURITY DEFINER functions'],
    [/\bCOPY\b/i, 'COPY'],
  ] as const)
    if (re.test(text))
      problems.push(`${what} is not allowed in module migrations`);
  return problems;
}
