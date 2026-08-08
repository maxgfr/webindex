# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

## [1.7.2](https://github.com/maxgfr/webindex/compare/v1.7.1...v1.7.2) (2026-08-08)


### Bug Fixes

* **build:** stop the CLI entry from gutting the vendored declarations ([080aef7](https://github.com/maxgfr/webindex/commit/080aef7c9f25863de984b84673986ca7e84f4fd1))

## [1.7.1](https://github.com/maxgfr/webindex/compare/v1.7.0...v1.7.1) (2026-08-08)


### Bug Fixes

* **release:** ship the CLI that was built, not the one from last time ([c715897](https://github.com/maxgfr/webindex/commit/c71589723ca363ad3acc4cf73e3ddb14ac3382e5))

# [1.7.0](https://github.com/maxgfr/webindex/compare/v1.6.0...v1.7.0) (2026-08-08)


### Features

* **cli:** ship a webindex command and an MCP server ([1c3433d](https://github.com/maxgfr/webindex/commit/1c3433de4d16f789130d9d8a3cbfe11febcb27bf))

# [1.6.0](https://github.com/maxgfr/webindex/compare/v1.5.0...v1.6.0) (2026-08-08)


### Features

* **text:** expose the matcher's patterns and canonicalOf ([10caaf1](https://github.com/maxgfr/webindex/commit/10caaf1a1008f22774a7a96e71266cb45b7d3462))

# [1.5.0](https://github.com/maxgfr/webindex/compare/v1.4.0...v1.5.0) (2026-08-08)


### Features

* **text:** add matcherFromTokens, the empty-query fallback ([0c104e1](https://github.com/maxgfr/webindex/commit/0c104e1271e0dca7113070414270bb0a769b0de2))

# [1.4.0](https://github.com/maxgfr/webindex/compare/v1.3.0...v1.4.0) (2026-08-08)


### Features

* **text:** let a consumer extend the stopword list, and prove the engine stands alone ([dee6c5a](https://github.com/maxgfr/webindex/commit/dee6c5a296e8b12185b184a2db43c30ad0305cc9))

# [1.3.0](https://github.com/maxgfr/webindex/compare/v1.2.0...v1.3.0) (2026-08-07)


### Features

* **text:** export isStopword, the vocabulary two scorers must share ([1ce065e](https://github.com/maxgfr/webindex/commit/1ce065e8539147e3a0fcbd544134ed570a599baa))

# [1.2.0](https://github.com/maxgfr/webindex/compare/v1.1.0...v1.2.0) (2026-08-07)


### Features

* **mcp:** move the MCP transport in, behind a skill adapter ([c8b533f](https://github.com/maxgfr/webindex/commit/c8b533f35e7a6623cb873bec089f331989b395ea))

# [1.1.0](https://github.com/maxgfr/webindex/compare/v1.0.0...v1.1.0) (2026-08-07)


### Features

* **fetch:** move the HTTP, extraction, Firecrawl and cache layer in ([2be403c](https://github.com/maxgfr/webindex/commit/2be403cf332d0e79380834cda3507ad9e530f15b))

# 1.0.0 (2026-08-07)


### Features

* **pdf,doc:** move the PDF and office-document extraction ladders in ([1e10865](https://github.com/maxgfr/webindex/commit/1e108652b1f801063b2d1649435925d839005c4f))
* vendorable zero-dep engine scaffold with brand injection ([c064b95](https://github.com/maxgfr/webindex/commit/c064b955c6594d127a345e7625f16f57b1356bb7))
