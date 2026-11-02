# eslint-plugin-callback-safety/

Custom ESLint plugin enforcing safe patterns for callbacks, external ID access, and Svelte component props.

## Files

| File                 | What                                                   | When to read                             |
| -------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `index.js`           | Plugin entry point — registers all rules               | Adding or removing rules from the plugin |
| `package.json`       | Plugin package metadata                                | Checking plugin version or dependencies  |
| `README.md`          | Full plugin documentation with rule descriptions       | Understanding what each rule enforces    |
| `QUICK-REFERENCE.md` | One-page rule cheat sheet                              | Quick lookup during code review          |
| `USAGE.md`           | Integration guide for configuring the plugin in ESLint | Setting up the plugin in a new project   |

## Subdirectories

| Directory | What                                                                          | When to read                                 |
| --------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| `rules/`  | Individual rule implementations (6 rules: callback params, external ID, etc.) | Modifying or debugging specific ESLint rules |
| `tests/`  | Rule unit tests using ESLint's RuleTester                                     | Testing rule behavior after changes          |
