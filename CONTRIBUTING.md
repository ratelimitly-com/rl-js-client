# Contributing to RateLimitly JavaScript Client

We welcome contributions! This project is licensed under the [MIT License](LICENSE).

---

## Zero Runtime Dependency Rule

`ratelimitly-client` is designed as a **zero external runtime dependency** package. All core functionality (binary encoding, cryptography, UDP wire protocol, DNS SRV resolution, and event dispatch) is built strictly on Node.js core modules (`crypto`, `dgram`, `dns`, `events`, `buffer`).

> **Rule**: Do not add runtime dependencies (`dependencies` in `package.json`). Tooling and dev dependencies (such as ESLint) must only be used on-demand during CI or development.

---

## Development & Testing Workflow

### Prerequisites
- Node.js `>= 20.0.0`

### Running the Test Suite
Run all unit and mock conformance tests:

```bash
npm test
```

### Running Linting & Hygiene Checks
Check JavaScript code quality and manifest coherence:

```bash
npx --yes eslint@10.8.1 .
git ls-files -z '*.js' '*.mjs' | xargs -0 -r -n1 -t node --check
```

### Running Example Code
```bash
npm run example
```

---

## Pull Request Guidelines

1. **Keep Pull Requests Scoped**: Submit focused PRs addressing a single feature or bug fix.
2. **Maintain Wire Protocol Conformance**: Any protocol or codec changes must match the central RateLimitly specification and cross-client test vectors.
3. **Include Tests & Types**: Ensure changes are accompanied by test coverage and corresponding updates to `index.d.ts` and `api_key_codec.d.ts`.
4. **Update Documentation**: Document new options or methods in `README.md` and relevant examples in `examples/`.
