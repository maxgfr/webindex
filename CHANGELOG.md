# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

## [1.18.1](https://github.com/maxgfr/webindex/compare/v1.18.0...v1.18.1) (2026-08-10)


### Bug Fixes

* **cite:** read a decimal comma as a decimal point, not a group separator ([fe88e60](https://github.com/maxgfr/webindex/commit/fe88e608f2bab6960dfbb7a1121efbb97ba259c9))
* **cli:** exit 2 on a missing required argument, and let the skill gate read a Set ([19d5703](https://github.com/maxgfr/webindex/commit/19d5703b367ef04eedc18840a02260e2010755a8))

# [1.18.0](https://github.com/maxgfr/webindex/compare/v1.17.0...v1.18.0) (2026-08-10)


### Features

* **orchestrate:** a phase can name its own agent options ([88fb2dc](https://github.com/maxgfr/webindex/commit/88fb2dce69bdc937c997591517d538f32aab1c0a))

# [1.17.0](https://github.com/maxgfr/webindex/compare/v1.16.0...v1.17.0) (2026-08-10)


### Features

* **orchestrate:** let a caller paste constants into the emitted workflow ([bffc3bc](https://github.com/maxgfr/webindex/commit/bffc3bca28b0f5108c49a1cd6ec2728f390af81d))

# [1.16.0](https://github.com/maxgfr/webindex/compare/v1.15.2...v1.16.0) (2026-08-10)


### Features

* **orchestrate:** a phase's ids get the run, not only the worklist ([af23403](https://github.com/maxgfr/webindex/commit/af23403ac2422b00016596caee09905db8c63f9b))

## [1.15.2](https://github.com/maxgfr/webindex/compare/v1.15.1...v1.15.2) (2026-08-10)


### Bug Fixes

* **embed:** cosine refuses what it cannot honestly answer ([29259ff](https://github.com/maxgfr/webindex/commit/29259ffa5be69cdc8abf6e27747108318afae32c))

## [1.15.1](https://github.com/maxgfr/webindex/compare/v1.15.0...v1.15.1) (2026-08-10)


### Bug Fixes

* **orchestrate:** refuse a run directory that does not exist ([7a54c66](https://github.com/maxgfr/webindex/commit/7a54c6627112514ea9b82e1043bec175181102d8))

# [1.15.0](https://github.com/maxgfr/webindex/compare/v1.14.0...v1.15.0) (2026-08-10)


### Bug Fixes

* **skillkit:** keep the dev-time toolchain out of the vendored bundle ([2d16118](https://github.com/maxgfr/webindex/commit/2d161189f01f69ea3138685c9690b0e8756e06a4))


### Features

* **changed,tables:** answer "did this change", and stop flattening tables ([fa207d9](https://github.com/maxgfr/webindex/commit/fa207d9445ba5d00dd25cfaaa9de90a83d8b7864))
* **cite:** the mechanics of reading citations, never the verdict ([9605ff9](https://github.com/maxgfr/webindex/commit/9605ff942c14454e9b6955d793aef84d11f69612)), closes [issue#45](https://github.com/issue/issues/45)
* **cli,mcp:** surface the new layers, and keep the engine out of the pool ([76efb3d](https://github.com/maxgfr/webindex/commit/76efb3d358894368d7c1be8c5603949f6a559e05))
* **crawl:** apply the Crawl-delay, and walk a site on purpose ([660aec4](https://github.com/maxgfr/webindex/commit/660aec4986f0e3214de98d8026708bcaa82a989c))
* **embed,vector:** reach the semantic stack this package already ships ([7ae4152](https://github.com/maxgfr/webindex/commit/7ae4152f3c43179f3f3f482053bcdea3c435e827))
* **orchestrate:** one emitter for the fan-out eight skills each rewrote ([a6f02e0](https://github.com/maxgfr/webindex/commit/a6f02e09d6bea891c6552c215daaabe4ead582c9))
* **run,cli:** a run directory and a validating command-line harness ([b9a6b79](https://github.com/maxgfr/webindex/commit/b9a6b79c9157133964ac18634b478fdd721c17f4))
* **skill:** the packaging toolchain, as commands instead of copied scripts ([3a35bde](https://github.com/maxgfr/webindex/commit/3a35bdea6aeef22c67f1f8b3388093d1d402e3df))

# [1.14.0](https://github.com/maxgfr/webindex/compare/v1.13.1...v1.14.0) (2026-08-09)


### Features

* **engine:** take the last 53 forks out of the consuming skills ([977bde7](https://github.com/maxgfr/webindex/commit/977bde77c049aa13e9ee669522e1414ef04458c8))

## [1.13.1](https://github.com/maxgfr/webindex/compare/v1.13.0...v1.13.1) (2026-08-09)


### Bug Fixes

* **charset:** decode Windows-1252 from a table, not from the runtime ([680070d](https://github.com/maxgfr/webindex/commit/680070d599193a25f7645a95469272a27732e011))

# [1.13.0](https://github.com/maxgfr/webindex/compare/v1.12.1...v1.13.0) (2026-08-09)


### Bug Fixes

* **cli:** route every stack service the engine declares ([e0be326](https://github.com/maxgfr/webindex/commit/e0be3268f0347d27b24a6ed921c434d7982535d3))
* **test:** stop the OCR stub writing files named --help and --version ([d0bfe42](https://github.com/maxgfr/webindex/commit/d0bfe427feb7bb4166475d4ccdfaa197feb85296))


### Features

* **cli,mcp:** surface every layer, and gate the docs against the code ([bbccd03](https://github.com/maxgfr/webindex/commit/bbccd0327d38df961fdd65d7fc047f730253d86f))
* **engines:** keyless web engines, and a discovery cascade ([479ad63](https://github.com/maxgfr/webindex/commit/479ad639ea6e2e3cc54a8cd2ef3ebcfa8e13ced9))
* **fetch,cache:** stream the byte cap, revalidate, and decode what was sent ([67983f3](https://github.com/maxgfr/webindex/commit/67983f342d649aefb0c6ec31dce994063faa9a3a))
* **forge:** forges, package registries, and repository refs ([0993f89](https://github.com/maxgfr/webindex/commit/0993f897145e81ac841030ebceb2905d793846cd))
* **rank:** fusion, BM25F, near-duplicate collapse and diversification ([177f142](https://github.com/maxgfr/webindex/commit/177f142cb03d1f401bad6c36916680b817b94df6))
* **web:** robots.txt, sitemaps, feeds and structured metadata ([e41bb6a](https://github.com/maxgfr/webindex/commit/e41bb6aa44651224b42c90943905339095e3fdc2))

## [1.12.1](https://github.com/maxgfr/webindex/compare/v1.12.0...v1.12.1) (2026-08-08)


### Bug Fixes

* **stack:** materialise the compose under <PREFIX>_CACHE_DIR ([9609b0f](https://github.com/maxgfr/webindex/commit/9609b0f78dbdc4e0a8b2b535f06b2a3d8b1905c0))

# [1.12.0](https://github.com/maxgfr/webindex/compare/v1.11.1...v1.12.0) (2026-08-08)


### Features

* **stack:** fold several services into one compose call ([b25a26e](https://github.com/maxgfr/webindex/commit/b25a26eeca53df1d0eb510a3831146e43ab8ea95))

## [1.11.1](https://github.com/maxgfr/webindex/compare/v1.11.0...v1.11.1) (2026-08-08)


### Bug Fixes

* **stack:** address the reader in the consumer's command, not the engine's ([2dbafae](https://github.com/maxgfr/webindex/commit/2dbafae1c6bdf906d69a800422931d8ca97820fe))

# [1.11.0](https://github.com/maxgfr/webindex/compare/v1.10.0...v1.11.0) (2026-08-08)


### Features

* **stack:** drive the containers as well as ship them ([0947790](https://github.com/maxgfr/webindex/commit/0947790f1c14c9dc242a8fe1f2905305d9065dcf))

# [1.10.0](https://github.com/maxgfr/webindex/compare/v1.9.0...v1.10.0) (2026-08-08)


### Features

* **search:** ask the local stack, not just start it ([7457a94](https://github.com/maxgfr/webindex/commit/7457a943d4cedf8716b544e94765131559adf312))

# [1.9.0](https://github.com/maxgfr/webindex/compare/v1.8.0...v1.9.0) (2026-08-08)


### Features

* **stack:** own the container stack, and document what the tool can do ([d61adec](https://github.com/maxgfr/webindex/commit/d61adec9f31ce9d5bece6e70084a1cf13b6c3079))

# [1.8.0](https://github.com/maxgfr/webindex/compare/v1.7.2...v1.8.0) (2026-08-08)


### Features

* add citability, provider URL shapes, locale and the run lock ([cef52e3](https://github.com/maxgfr/webindex/commit/cef52e318654ba36f5a12605e409aa71b33ebc26))

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
