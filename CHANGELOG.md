# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

## [1.21.1](https://github.com/maxgfr/webindex/compare/v1.21.0...v1.21.1) (2026-09-29)


### Bug Fixes

* **cache:** use the default cache directory only once it proves to be yours ([7c91077](https://github.com/maxgfr/webindex/commit/7c91077859eb40d3511a2731682ca94d7669d288))
* **cache:** warn once when the default cache directory is refused ([d8d83b8](https://github.com/maxgfr/webindex/commit/d8d83b8db5f0d087353a03229abdc5d7578c68e1))
* **charset:** honour <meta charset> in every body the extractor reads as HTML ([acf012f](https://github.com/maxgfr/webindex/commit/acf012f8a0171d970b8e2fc364921b10aea71a55))
* **charset:** keep a UTF-8 page UTF-8 when one stray byte sits mid-body ([390b6f5](https://github.com/maxgfr/webindex/commit/390b6f5e1475090dbc0dcdf545904c983cb35509))
* **doc:** leave tracked deletions out of OpenDocument text ([96a80f1](https://github.com/maxgfr/webindex/commit/96a80f1638488314e0e32117a6c1ee81a5e927ed))
* **doc:** meter office table rules for the whole document, and keep a run of empty rows to one ([8e95b38](https://github.com/maxgfr/webindex/commit/8e95b38e9e75441a7676836990ebdeff35798239))
* **fetch:** detect role=main whatever the case it is written in ([fcac5fa](https://github.com/maxgfr/webindex/commit/fcac5fa9b02f5924ae1299460a881612dc9839eb))
* **fetch:** flag Cloudflare's "Sorry, you have been blocked" page as a wall again ([b4f8d0a](https://github.com/maxgfr/webindex/commit/b4f8d0a6dcc7dfc0b767b84edcf8125bcf50ab4b))
* **fetch:** let a cancel end httpGet's back-off wait ([63b1010](https://github.com/maxgfr/webindex/commit/63b10109e428cd470cf5b462227e45bfe69aade2))
* **fetch:** restore a <pre> set inside a heading instead of leaking its NULs ([4ad8022](https://github.com/maxgfr/webindex/commit/4ad8022d9fee836e1e03c9ea8e05867ea935e64c))
* **fetch:** restore an inline <pre> slot without a control-character regex ([d8d7ad7](https://github.com/maxgfr/webindex/commit/d8d7ad76a10387ce5901c6898470606021645f7e))
* **html:** take no <script> quoted in an attribute or a title for one ([0791219](https://github.com/maxgfr/webindex/commit/0791219a7f469235d89e8851d8f9f448cd058d20))
* **markdown:** apply a relative <base href> once in fetch --format markdown ([acf336a](https://github.com/maxgfr/webindex/commit/acf336a778f21f450b73901498d7a9fafe621911))
* **markdown:** drop a javascript:/data: link hidden behind leading control characters ([b275b83](https://github.com/maxgfr/webindex/commit/b275b838c38c41ba409983666590598675acbf22))
* **markdown:** escape a '<' or '&' an element splits from the rest of its tag ([6c0f152](https://github.com/maxgfr/webindex/commit/6c0f152367ab950ecb3cf25c3d6fa50a85e60c3a))
* **markdown:** escape a heading title made only of '#' ([d616691](https://github.com/maxgfr/webindex/commit/d616691541ad3bd9202c9fb74cecb0ab8542d0e4))
* **markdown:** escape a single tilde that could close a GFM strikethrough ([f2dcc98](https://github.com/maxgfr/webindex/commit/f2dcc9813e8398581de3e8576670bf54d25f478c))
* **markdown:** keep the blank line a nested list needs to be a list ([341d3c4](https://github.com/maxgfr/webindex/commit/341d3c477096f41960280e82e4e93dab6f77c15c))
* **markdown:** keep two adjacent lists of the same kind apart ([5477868](https://github.com/maxgfr/webindex/commit/5477868877df6cddd62e523658c5ee9a0e5a692e))
* **markdown:** move an emphasis's edge punctuation outside its markers against a letter ([355692d](https://github.com/maxgfr/webindex/commit/355692dcced84c5c70cf49cade204e3dd116b2e4))
* **markdown:** percent-encode a backslash in a link destination ([af3dad6](https://github.com/maxgfr/webindex/commit/af3dad60fd2630e4d493b899c8c0a7a614eca25d))
* **markdown:** write a rule as *** so an <hr> opening a list item stays in it ([a7542a8](https://github.com/maxgfr/webindex/commit/a7542a8623a61561009f7e4e76419328b64c59e7))
* **pdf:** cap the native reader's ASCII85 decode like an inflation ([fee134e](https://github.com/maxgfr/webindex/commit/fee134e7ae9fb38d20a84b7ace483f69e6121103))
* **pdf:** report a tool's error, not Node's throw site or local paths, as its failure ([e4982a3](https://github.com/maxgfr/webindex/commit/e4982a3dccf2d428154a0a51817d1913ad82305f))
* **structured:** rank the work a page presents above an Organization subtype ([093b0e9](https://github.com/maxgfr/webindex/commit/093b0e9fa0da4e7bd61cadea3bfa05208d79f5ed))
* **structured:** skip a JSON-LD block nested deeper than any real one ([9a965d5](https://github.com/maxgfr/webindex/commit/9a965d51d60d2e459b3fd57df85b4473efb0f5da))
* **structured:** skip comments while scanning for JSON-LD blocks ([fb7f267](https://github.com/maxgfr/webindex/commit/fb7f2672d992da51ab2d9d43a66610b8d09e0c29))
* **text:** keep a '+' after a digit out of the keyword ("Node 18+" is 18) ([cc8ee1a](https://github.com/maxgfr/webindex/commit/cc8ee1a528ab9b000ae3d40e6147e91d895f9907))
* **text:** keep a French or German stopword written in capitals as a term ([73ad2ad](https://github.com/maxgfr/webindex/commit/73ad2adbdae28b960bc1ab2c17f18b7555e08268))
* **text:** read a heading's '\#' as a hash, and its closing run only after a space ([5dd27c8](https://github.com/maxgfr/webindex/commit/5dd27c8bd915a918132d1b3d77b07e7becf1b208))


### Performance Improvements

* **fetch:** download no more of a body declared too large than it can use ([fb7c691](https://github.com/maxgfr/webindex/commit/fb7c69109a52db446c9c1d356ee73ea780e08cc2))
* **structured:** dedupe meta authors through a Set, and bound the list ([713bba5](https://github.com/maxgfr/webindex/commit/713bba5f8d31da3c66d72d429b16e6279bde6eb1))

# [1.21.0](https://github.com/maxgfr/webindex/compare/v1.20.0...v1.21.0) (2026-09-28)


### Bug Fixes

* **build:** check-vendorable sees dynamic imports and requires too ([3e14443](https://github.com/maxgfr/webindex/commit/3e144439dfca15ce4cc9c9fb8194dd8fcea7f9d1))
* **cache:** clean and count only the cache's own files, default to a per-user dir ([f18ef67](https://github.com/maxgfr/webindex/commit/f18ef67912c8bb02f6635acf164be98204c929c1))
* **cache:** revalidate once, keep a 304's validators, cache Firecrawl fallbacks, key reads by consent/full-page ([4ef3f6b](https://github.com/maxgfr/webindex/commit/4ef3f6b6e5536a99416375c6ad306d7115aa84f2))
* **changed:** hash raw bytes, keep a 304's fresh observation, let the hash outrank validators ([9b351e3](https://github.com/maxgfr/webindex/commit/9b351e39f93c26b3ab3672091a765c9e08827971))
* **charset:** read meta charsets as the prescan does, honour XML declarations, rescue undeclared Latin-1 ([e73bebf](https://github.com/maxgfr/webindex/commit/e73bebfbd977678c17c521f27a9c646405a6bf08))
* **charset:** respect quotes when finding a meta tag's end ([40afe0c](https://github.com/maxgfr/webindex/commit/40afe0cf87c0b18eae7de3e2add1e7b86b60b6b1))
* **citable:** cite Bugzilla, refuse the JSON APIs, and read arXiv and PMC links ([4154250](https://github.com/maxgfr/webindex/commit/41542504cdef19c309811c565db27a43a332ed8f))
* **cite:** read million-scale figures, nested fences, i18n appendices and reference definitions ([5e91a8e](https://github.com/maxgfr/webindex/commit/5e91a8efa2cf61e0eba6950db51202a40e5651d7))
* **cli:** doctor says what each extraction rung will do, not that it is enabled ([47617a0](https://github.com/maxgfr/webindex/commit/47617a0ed0e7e74d3ccc046cf06f07debc131adc))
* **cli:** fetch says its note on stderr when it also has text ([ce25bed](https://github.com/maxgfr/webindex/commit/ce25bedee08d577efe895f968afe600373da720b))
* **cli:** refuse a budget of nothing, a stray argument and a value outside its set as usage errors, and answer `<command> --help` ([0ec8675](https://github.com/maxgfr/webindex/commit/0ec8675c99dcb303d578ce4dbaa37cdbfd28bfb9))
* **cli:** run when started under any file name, not only one named webindex ([4ac8233](https://github.com/maxgfr/webindex/commit/4ac8233ddfeadc13944384f238e0c1f26a042c7b))
* **cli:** say robots checks were switched off, not that there was no file ([8ff91ad](https://github.com/maxgfr/webindex/commit/8ff91ad66a5710fc2bc221defdb53f4e1e930839))
* **cli:** stop quietly on EPIPE, and load node:http only for the HTTP transport ([aa7aeb8](https://github.com/maxgfr/webindex/commit/aa7aeb8647aa148ef45f55192e107606b1e403a0))
* **crawl:** bound requests, follow the seed's own redirect, and hold a throttled host ([3ee5efb](https://github.com/maxgfr/webindex/commit/3ee5efbc56e76a2cb61680803b7c9f60fcf9eff1))
* **crawl:** read links by tag and attribute name, in linear time ([99d8403](https://github.com/maxgfr/webindex/commit/99d8403826dd59d93b050642abc9231aa062df3c))
* **embed:** task prefixes for the model, no batches after a failure, a down server re-probed, fusion by position ([6c6e684](https://github.com/maxgfr/webindex/commit/6c6e684eddca0bb0f909b2e6e32ec7f6a74c5467))
* **engines:** page DuckDuckGo by its own Next form, and ask it for no region by default ([6d6b145](https://github.com/maxgfr/webindex/commit/6d6b14592f58a6ecb4e5ed9a1e00aadec585778c))
* **engines:** parse the engines' real markup, in linear time ([373835f](https://github.com/maxgfr/webindex/commit/373835f1fa6568a1aeb59a2f342d0cbd4283e142))
* **exec:** kill a timed-out command's whole tree, decode split UTF-8, never throw on NUL ([676b055](https://github.com/maxgfr/webindex/commit/676b05585f4e17963dd65a5439a929534bd1ce63))
* **feed:** read feeds and sitemaps the way their formats are written ([a6d08bb](https://github.com/maxgfr/webindex/commit/a6d08bb2da2bd0756a31b5887847ca22aca60376))
* **fetch:** cleanInline strips formatting markup, not every angle bracket ([61efdae](https://github.com/maxgfr/webindex/commit/61efdaea74a2cc630e6b20348102378833e5399f))
* **fetch:** decode character references by the HTML spec's rules ([279c734](https://github.com/maxgfr/webindex/commit/279c734c750877724559c225164f0b8fc87f22d9))
* **fetch:** drop navigation, banner and contentinfo landmarks like <nav> and <footer> ([a601e07](https://github.com/maxgfr/webindex/commit/a601e079f2d2fa4b1f6ecfea1266f2dd9d210722))
* **fetch:** flag a wall by its shape, not by one phrase ([e00c128](https://github.com/maxgfr/webindex/commit/e00c12817bbb0f0f75a58225a1ed3d86413ec635))
* **fetch:** gate the consent filter on banner voice and button length ([7b4b3ac](https://github.com/maxgfr/webindex/commit/7b4b3ac0b5e8b98bac8f52de2e392b0f2ea78425))
* **fetch:** honour a long Retry-After instead of retrying through it ([6252205](https://github.com/maxgfr/webindex/commit/625220538fdce9d012b9693caecc06159328dcc2))
* **fetch:** htmlToText reads headings, inline markup and <pre> as rendered ([283acd4](https://github.com/maxgfr/webindex/commit/283acd45276cbaf6bbf5b64bf99bffe22429a201))
* **fetch:** keep attribute and permalink scans linear; share HTML primitives ([87e10bb](https://github.com/maxgfr/webindex/commit/87e10bba0d09d7814d1be7f67fa0e58df152886e))
* **fetch:** keep htmlToText and extractMainHtml linear on hostile markup ([f7a5640](https://github.com/maxgfr/webindex/commit/f7a5640959657e95c7bd170cb70ee817340fc13c))
* **fetch:** pick the right main region — role=main, sibling posts, no script bytes ([d4926d5](https://github.com/maxgfr/webindex/commit/d4926d549c3f2e8360be72a04136f33fbf691c64))
* **fetch:** read a text body's capped prefix whatever its Content-Length ([58c0eec](https://github.com/maxgfr/webindex/commit/58c0eec31e38860383371e0fb5f90650f1ad487c))
* **fetch:** report the real network failure and stop retrying permanent ones ([40eefb6](https://github.com/maxgfr/webindex/commit/40eefb63cff588ff9940b9788736dcecc31286ba))
* **fetch:** resolve the canonical, and title pages from their own name ([acdcc9d](https://github.com/maxgfr/webindex/commit/acdcc9dbdda2b9cbeb8fe054e83e597d97d31a40))
* **fetch:** route documents by their bytes, never return raw binary as text ([2886db8](https://github.com/maxgfr/webindex/commit/2886db87ba509f756e8a81bea5dc95756addd56e))
* **fetch:** still refuse an over-long answer to a Range request unread ([c53a9df](https://github.com/maxgfr/webindex/commit/c53a9df3149a046c2a865f28dcf05206ed726d5d))
* **firecrawl:** make the search rung work on /v1, honour the limit and locale, cite the post-redirect URL, and drop a dead instance ([8f78eba](https://github.com/maxgfr/webindex/commit/8f78ebaa5f704b619f84e142ae8a6b0d270f6394))
* **forge:** let GitHub rank a search by relevance, and relax a search that matched nothing ([fba88f5](https://github.com/maxgfr/webindex/commit/fba88f5af088fc0dbf8711da146f7519e77f26e0))
* **forge:** read Gitea and GitLab by their own field names, and link releases and tags ([a798948](https://github.com/maxgfr/webindex/commit/a79894885564fa2b079cd2a878c64202b9cffd47))
* **forge:** say which failure it was — missing, bad token, quota, outage or network ([7bd9fe4](https://github.com/maxgfr/webindex/commit/7bd9fe4cd161c139b55c91aee47a3d4e959727ac))
* **forge:** send a token only to its own forge, and never across a redirect ([b7ccc9f](https://github.com/maxgfr/webindex/commit/b7ccc9f3eeb5d568a388ba68fbe4eb60537857d3))
* **locale:** read a language tag's script and region properly, and speak DuckDuckGo's own kl codes ([911a9be](https://github.com/maxgfr/webindex/commit/911a9beb5f57cd618dff03e90f9ec4688125e132))
* **markdown:** headings without their self-links, MDN's code language, and a list nested with no item round it ([ae67271](https://github.com/maxgfr/webindex/commit/ae67271f042a74c6575f1d5cef20364dcec2399a))
* **markdown:** ignore a data: or javascript: <base href>, as a browser does ([2f0b17d](https://github.com/maxgfr/webindex/commit/2f0b17db80a305dab053e3eecb00329a427127de))
* **markdown:** no image from a "!" before a link, and code laid out in a table stays verbatim ([05cffe2](https://github.com/maxgfr/webindex/commit/05cffe21d643940744c1b4a463e19d3c0b292d0b))
* **mcp:** answer no responses, reject ids and arguments of the wrong shape, serve only listed resources ([5d01809](https://github.com/maxgfr/webindex/commit/5d01809101b681435f43e031a5176a8145dbd355))
* **mcp:** keep reading stdin while every slot is busy, and read batches the way each revision does ([b6c99c1](https://github.com/maxgfr/webindex/commit/b6c99c13cb6629fd823b0d712abe57e39f471b19))
* **mcp:** say in the tool declarations the limits a call will actually meet ([5dc29d8](https://github.com/maxgfr/webindex/commit/5dc29d87f764389a9d6680dd1bcca44e295a3241))
* **mcp:** stream SSE only for a request with a usable id ([1e7f23b](https://github.com/maxgfr/webindex/commit/1e7f23b919d846e5260328abacffd606194ca66a))
* **mcp:** write no SSE event to a client that already hung up ([c196a49](https://github.com/maxgfr/webindex/commit/c196a49d9829329f7d7efd88023fc8e590285ec2))
* **orchestrate:** the runbook counts the agents the script launches, shq folds a lone CR, envInt says it clamps ([cc314bd](https://github.com/maxgfr/webindex/commit/cc314bd10c1ffcd129c61d54f0ed0c68c7b38c2e))
* **pdf:** let the quality gate pass form feeds and fill-in rules, in one pass ([4ff7fef](https://github.com/maxgfr/webindex/commit/4ff7fefac0cec58744ac0eb6104887abdae48f5a))
* **pdf:** make the native reader linear-time and bounded, and read what it misread ([2c93192](https://github.com/maxgfr/webindex/commit/2c93192452ffe7f27c6cbf982031f7aa9cec1ef0))
* **pdf:** name a failing tool once when its own message already does ([d2e1b5c](https://github.com/maxgfr/webindex/commit/d2e1b5c11ea6c017a91081b1ee2df6dfa4119810))
* **pdf:** read PDF_ENGINE and DOC_ENGINE as comma lists, and say what was ignored ([6453bf2](https://github.com/maxgfr/webindex/commit/6453bf23cb541e947a32900c38c705adacd68a56))
* **pdf:** reserve the OCR budget before converting, not after ([4dd4c7c](https://github.com/maxgfr/webindex/commit/4dd4c7c5970f5bc84bbad241bc469e36080fa409))
* **pdf:** run the npx.cmd shim through a shell on Windows ([dda6a7c](https://github.com/maxgfr/webindex/commit/dda6a7c772100c0d9e32b38cb6c6caf285e921f2))
* **pdf:** tell a rung that cannot run from one that rejected a document ([af9b9ff](https://github.com/maxgfr/webindex/commit/af9b9ff866e5832c6360085eac1e5f62218b7f18))
* **pool:** run a NaN width sequentially, and start nothing after a rejection ([d972710](https://github.com/maxgfr/webindex/commit/d972710331e91774e9772a465768548e88b899a1))
* **providers:** refuse a multi-record efetch, and recognise landing URLs with a query, a fragment or the legacy NCBI paths ([d51ae70](https://github.com/maxgfr/webindex/commit/d51ae70ed964cf32aa3d0d0c97649bb7029b7ff0))
* **rank:** relevant before irrelevant in MMR, CJK/Indic/identifier terms, machine-independent ties ([35cd360](https://github.com/maxgfr/webindex/commit/35cd36029f4ae9074acb35722723cfdbd97420a2))
* **registry:** answer an empty package name without asking any registry ([155779d](https://github.com/maxgfr/webindex/commit/155779d4acf1a8d64c23f5165ce5ff9b584b3d36))
* **registry:** read crates.io's 400 for an impossible version as "no", and say why a registry failed ([77b4e2c](https://github.com/maxgfr/webindex/commit/77b4e2cfba85954cd5345ed483e87bf52ebb9145))
* **registry:** stop at a registry that failed, answer the version asked for, and read modern metadata ([5e79ab6](https://github.com/maxgfr/webindex/commit/5e79ab6fb7018d47997543cba913e45034910ac6))
* **repo:** an empty branch still means the default clone, and cleanup never masks a clone error ([a8ff238](https://github.com/maxgfr/webindex/commit/a8ff238d2306a5b68fec4b5212da5706c30b5160))
* **repo:** one clone per repository and branch, cloned once, refreshed honestly ([cd1209b](https://github.com/maxgfr/webindex/commit/cd1209b63a2f3242206e0de3e9602e4a0bb82cb9))
* **repo:** read owner/repo out of a browser URL, keep ssh transports, refuse dot segments ([9f2db03](https://github.com/maxgfr/webindex/commit/9f2db036df25a7d3767e0572c1dff152bdbeb3d2))
* **robots:** match rules in linear time, and read the file the way RFC 9309 does ([a5b9419](https://github.com/maxgfr/webindex/commit/a5b94195418fa5cc55cd31b04572902a5e7b0cd6))
* **search:** abort the SearXNG or engine request in flight when the search is cancelled ([1b1f85e](https://github.com/maxgfr/webindex/commit/1b1f85e693498550bdc272c8438f26c0e11106dd))
* **search:** bound a search in time — no retries inside the cascade, and an overall budget ([5638600](https://github.com/maxgfr/webindex/commit/56386005fbe6411164143dec97cf91dc103f6478))
* **search:** count a sliver of budget left after an abort as spent ([9800cd7](https://github.com/maxgfr/webindex/commit/9800cd70044230dc05dcf41c99a4d54438ee0644))
* **search:** let a "down" probe verdict expire, check SearXNG is SearXNG, and name a json-disabled instance ([c8bf310](https://github.com/maxgfr/webindex/commit/c8bf31090aa118a99f2ea737f30b99a73d196559))
* **search:** name the caller's budget, not what was left of it, when SearXNG is never asked ([c98d168](https://github.com/maxgfr/webindex/commit/c98d1682a3e3d884e7828e803c2048a1734be5d0))
* **search:** say "nothing was searched" when no rung answered, and report each rung's outcome as data ([94b4e57](https://github.com/maxgfr/webindex/commit/94b4e57f54b1b7fe916df24d817752f84571ac24))
* **search:** spend SearXNG's probe from the same budget, and do not query once halted ([32bf20e](https://github.com/maxgfr/webindex/commit/32bf20ed2db6c0c961e3f29a5591c1f89714a6f5))
* **skillkit:** recall says when it compared nothing, and repin/finish name the missing gh ([5cb77ff](https://github.com/maxgfr/webindex/commit/5cb77ffea376c9f646b5b369ba7a07872d7e83bf))
* **skillkit:** vendor without gh, scaffold CI that never runs `npx webindex`, and a current minRef ([0ddedb5](https://github.com/maxgfr/webindex/commit/0ddedb5905933073c57558bbae7216c04a7f7bc9))
* **stack:** hold the default cache location's per-user directory to the ownership rule ([220f089](https://github.com/maxgfr/webindex/commit/220f0898f1e946eef365199acba314f565a893dc))
* **stack:** keep the compose file beside the fetch cache, refuse one it cannot vouch for, and name a stopped daemon ([bfd5bf6](https://github.com/maxgfr/webindex/commit/bfd5bf6679ccabe4e1316fc84830f34f780a76df))
* **stack:** refuse a stack in a world-writable directory, and end the ownership walk at the cache root however it is spelled ([7759f83](https://github.com/maxgfr/webindex/commit/7759f83059befbffc58b3633751c622103316814))
* **structured:** describe the page's primary entity, with every author and a real canonical ([333f2d3](https://github.com/maxgfr/webindex/commit/333f2d38087fb9b8173fc56fc30e4598727d56a3))
* **structured:** name the site from a news publisher, and drop an unresolvable URL ([c6facbe](https://github.com/maxgfr/webindex/commit/c6facbeb48d1dbaceabf3cdba73f879d35cfdd0f))
* **tables:** read tables with a linear tokenizer that knows HTML's table rules ([b03b824](https://github.com/maxgfr/webindex/commit/b03b8242499b008770b0356fe101c5a26616f0f9))
* **text:** keywords and the matcher read Hindi, Thai, Tamil and CJK as bm25Tokenize does ([649d3e0](https://github.com/maxgfr/webindex/commit/649d3e04120c9efec92ec3696362c31d5d4fc63b))
* **text:** match short keywords as words, keep C++/C#/.NET/HTTP/2, fold ligatures ([e0cfb96](https://github.com/maxgfr/webindex/commit/e0cfb9657e3e6790f4292fa0e1294176c47e0255))
* **text:** suffix a lossy slug with a hash, so two repositories never share a clone ([8de088f](https://github.com/maxgfr/webindex/commit/8de088f02413b8c584b22a47309646b8f357abb6))
* **url:** keep ?ref=, and strip the click ids canonicalizeUrl kept ([69719c8](https://github.com/maxgfr/webindex/commit/69719c8ee6cbaf01da51df63a1946b005250d64a))
* **vector:** chunk upserts under Qdrant's request cap, refuse a collection of another dimension ([54029ba](https://github.com/maxgfr/webindex/commit/54029ba2529a99ba7d9b57e50ea2fdd7ce9e350b))


### Features

* **cite:** read grouped and doubly-bracketed citations as their parts ([9ab2808](https://github.com/maxgfr/webindex/commit/9ab28086564fa1275bf121057b1f591f5ed3a838))
* **cli:** `webindex help <command>` answers for that command ([51cb83a](https://github.com/maxgfr/webindex/commit/51cb83a09213e17e91108ca9e4c6e9b10fc1993d))
* **cli:** crawl --prefix and --no-sitemap, and one answer for --max 0 ([3f01184](https://github.com/maxgfr/webindex/commit/3f01184570d0850b32ddb4029fad454268d0cf78))
* **cli:** doctor --json and cache clean --json, and say which commands take --json ([931b4e0](https://github.com/maxgfr/webindex/commit/931b4e025f7b5d3fbbe07ee5481002aaefe0790d))
* **cli:** fetch several URLs in one run ([482ffbd](https://github.com/maxgfr/webindex/commit/482ffbdf4f827790f3dde2d1dc8e648ab334ffc0))
* **cli:** opt-in fetch cache (--cache/--refresh/--offline, MCP `cache`) and provenance in the output ([83ed060](https://github.com/maxgfr/webindex/commit/83ed0602e184334ca67956b34e98b98895b3105f))
* **cli:** tables and meta read a saved page, and extract, tables and meta read stdin for - ([43f54ce](https://github.com/maxgfr/webindex/commit/43f54cebf88039438dccd0c82e47f4f115054375))
* **doc:** built-in office reader shows dates, slide titles and tables, styled headings and lists ([b374d5e](https://github.com/maxgfr/webindex/commit/b374d5e9a778984325a535fa7dc8f6a79c4eed86))
* **doc:** read an OpenDocument presentation's titles and notes as a .pptx's ([5d7e5ea](https://github.com/maxgfr/webindex/commit/5d7e5ea7b45cb161d0e0521cbbf0c8ea89fa843d))
* **doc:** read OOXML and OpenDocument with a built-in, bounded last rung ([ff5c2ab](https://github.com/maxgfr/webindex/commit/ff5c2ab75c70457162db66effa8149a0f2ba85b9))
* **embed:** embed a file of texts in one run; say plainly that webindex_embed fails without a server ([81e9038](https://github.com/maxgfr/webindex/commit/81e903896720debeffff8a0ff3e724c306a74cd9))
* **fetch:** --format markdown on fetch and extract, and a format argument on their MCP tools ([178b932](https://github.com/maxgfr/webindex/commit/178b932676c0f389fd1b38b9aa79255b5f11c4b2))
* **fetch:** make the request timeout configurable and stop retrying it ([18b7e20](https://github.com/maxgfr/webindex/commit/18b7e204731028fcf1aeb3535bdd8c496aea07d3))
* **forge:** self-hosted forges, a local checkout as its origin, and a tags command ([6da888f](https://github.com/maxgfr/webindex/commit/6da888f2052a6deeb2d7cf23a908879d9eb557fb))
* **markdown:** htmlToMarkdown, HTML to CommonMark without a DOM ([b4a0513](https://github.com/maxgfr/webindex/commit/b4a0513e05dbbee74cf6aa2e2dc3ac3fdbcfd0af))
* **mcp:** annotate every webindex tool as read-only, and the web-facing ones as open-world ([a7e4277](https://github.com/maxgfr/webindex/commit/a7e4277d817dcf1209997404ae20aec64e3ffce3))
* **mcp:** cancellation stops the work, and long tools report progress ([5baa247](https://github.com/maxgfr/webindex/commit/5baa247489ac8026cb24e8d2a6705a796ead68e5))
* **mcp:** opt-in walls for a server others can reach — public addresses only, one directory, a bearer token ([a6eb7d8](https://github.com/maxgfr/webindex/commit/a6eb7d8e974c29ac1c102e5885e0e27f43e4ecce))
* **rank:** fuse a document's own score and an optional dense lane; say when nothing matched ([5806839](https://github.com/maxgfr/webindex/commit/5806839235c2a1509f815d90ca585bf2626e8f2e))
* **rank:** report which URL each collapsed near-duplicate duplicated ([ab0f43e](https://github.com/maxgfr/webindex/commit/ab0f43eaf25bea5e8efe797d061cc200bdc2c6d4))
* **search:** --region on the CLI, and region and pages on webindex_search ([dd1044b](https://github.com/maxgfr/webindex/commit/dd1044b9889b1ba6459a58994fa6310a48427d9b))


### Performance Improvements

* **pdf:** find each npx rung's executable once, then run it directly ([82275d7](https://github.com/maxgfr/webindex/commit/82275d7c304bc9dc52ed440c4e32081003ce485b))
* **rank:** cache each identifier's inner words by raw token ([5e0d5d5](https://github.com/maxgfr/webindex/commit/5e0d5d504d0e3c425615b3e133b1b4810e918db1))
* **rank:** exact MMR by interned-token merge, a bounded window in rank, one tokenisation per body ([d9300d6](https://github.com/maxgfr/webindex/commit/d9300d67fafb576ce60daa4e1d9036d653c05ee8))
* **text:** look extra stopwords up in a set instead of scanning them per token ([9e89616](https://github.com/maxgfr/webindex/commit/9e89616a3a4f1dde997d1d8d46caf57418560083))

# [1.20.0](https://github.com/maxgfr/webindex/compare/v1.19.7...v1.20.0) (2026-09-12)


### Bug Fixes

* consent filter keeps short lines that only name a regulation ([bc3b09b](https://github.com/maxgfr/webindex/commit/bc3b09b0f7dce59ca7b53a42703ef1b85ed7d039))
* consent filter no longer drops short prose that merely mentions cookies ([565b76f](https://github.com/maxgfr/webindex/commit/565b76f71d57140cb3132ca49384464c6b83ad94))
* extract decodes local files by BOM and meta charset, with a Windows-1252 rescue ([297124c](https://github.com/maxgfr/webindex/commit/297124ce91cfd39259b7c35d19d02b6d2a17b94b))
* quote-aware tag matching and raw-text blocks before comments in htmlToText ([7939732](https://github.com/maxgfr/webindex/commit/7939732526c841c743a6af4586f85b00874b32dd))
* strip comments and raw-text blocks in one pass, sniff charset only for HTML ([2c0c15e](https://github.com/maxgfr/webindex/commit/2c0c15e2659503e5b92e252969f59bd737219b51))


### Features

* extract applies the same main-content and consent pipeline as fetch (--full-page opts out) ([abbafbc](https://github.com/maxgfr/webindex/commit/abbafbca9189ae8bb8441a5bc9720b811a9731b8))

## [1.19.7](https://github.com/maxgfr/webindex/compare/v1.19.6...v1.19.7) (2026-09-09)


### Bug Fixes

* **skills:** preserve manual invocation across agent hosts ([acd25f8](https://github.com/maxgfr/webindex/commit/acd25f8c8a687fccfe7667c43e0706ac9c9d992c))

## [1.19.6](https://github.com/maxgfr/webindex/compare/v1.19.5...v1.19.6) (2026-09-09)


### Bug Fixes

* keep HTML API reference pages citable ([046fab7](https://github.com/maxgfr/webindex/commit/046fab7c8daeda6513b28d89f0240b563f34d232))

## [1.19.5](https://github.com/maxgfr/webindex/compare/v1.19.4...v1.19.5) (2026-09-09)


### Bug Fixes

* harmoniser le chemin d’orchestration dans les déclarations ([c64c758](https://github.com/maxgfr/webindex/commit/c64c75883094f2823c0093eb3c375ea615c71ecf))

## [1.19.4](https://github.com/maxgfr/webindex/compare/v1.19.3...v1.19.4) (2026-09-08)


### Bug Fixes

* **skillkit:** keep workflow updates outside bot repins ([dbf3941](https://github.com/maxgfr/webindex/commit/dbf39418e211b2519e7f89c15425751345f55ed1))

## [1.19.3](https://github.com/maxgfr/webindex/compare/v1.19.2...v1.19.3) (2026-09-08)


### Bug Fixes

* **skillkit:** complete workflows on the fork origin ([62b0667](https://github.com/maxgfr/webindex/commit/62b0667ff63769a259238583eb608075ee232218))

## [1.19.2](https://github.com/maxgfr/webindex/compare/v1.19.1...v1.19.2) (2026-09-08)


### Bug Fixes

* **skillkit:** attribute symbol usage to the imported engine ([cced85c](https://github.com/maxgfr/webindex/commit/cced85cebe333284858f048ad4d7c8beaaa3425d))

## [1.19.1](https://github.com/maxgfr/webindex/compare/v1.19.0...v1.19.1) (2026-09-08)


### Bug Fixes

* **skillkit:** verify lazy engine versions and ship workflow contract ([aa7e175](https://github.com/maxgfr/webindex/commit/aa7e175bcf3e8e1cd85e2a4dc1e42b8d1a87966f))

# [1.19.0](https://github.com/maxgfr/webindex/compare/v1.18.10...v1.19.0) (2026-09-08)


### Features

* **skillkit:** share verified engine repins and publication recovery ([1f15b78](https://github.com/maxgfr/webindex/commit/1f15b785331f6a03576db2741c015808d5f0b2d8))

## [1.18.10](https://github.com/maxgfr/webindex/compare/v1.18.9...v1.18.10) (2026-09-07)


### Bug Fixes

* harden retrieval and MCP workflows with verified integrations ([9341b72](https://github.com/maxgfr/webindex/commit/9341b723a3504439e8ea0b21f99b5688fc770f02))

## [1.18.9](https://github.com/maxgfr/webindex/compare/v1.18.8...v1.18.9) (2026-09-03)


### Bug Fixes

* **docs:** describe bounded registry requests ([23a7100](https://github.com/maxgfr/webindex/commit/23a71002b8ceafc6ee23393142e431fe44a61279))
* **registry:** bound optional npm enrichment ([554994c](https://github.com/maxgfr/webindex/commit/554994cccd8db594ec925b54b2577beea4a752ca))
* **registry:** handle escaped npm suffix boundaries ([e4ea967](https://github.com/maxgfr/webindex/commit/e4ea967b44063d7ba0e67579c0d8811a4d637bc3))
* **registry:** parse npm time suffix linearly ([6f09667](https://github.com/maxgfr/webindex/commit/6f09667aa61dca18935dc6bc7970462aa556a09b))
* **registry:** preserve npm publication metadata ([4aa2c27](https://github.com/maxgfr/webindex/commit/4aa2c27ecea93b6ccd7ad471c3c8bf1eaa34da29))
* **registry:** use compact npm version documents ([12ef6c3](https://github.com/maxgfr/webindex/commit/12ef6c3df3651225679399af388c1a1c6a15f22f))


### Performance Improvements

* **registry:** reuse npm packument timestamps ([005a66a](https://github.com/maxgfr/webindex/commit/005a66ad439e12d0b806e9cf6f9ceb00e0e616cb))

## [1.18.8](https://github.com/maxgfr/webindex/compare/v1.18.7...v1.18.8) (2026-09-02)


### Bug Fixes

* **crawl:** do not judge or probe a URL the page budget will never reach ([7a4f45f](https://github.com/maxgfr/webindex/commit/7a4f45f4047bd107368c80d07e43cdd6d50365e6))
* **crawl:** stream onPage in frontier order, and say what maxPages counts ([acf3a18](https://github.com/maxgfr/webindex/commit/acf3a184e8f2fb2cb417acd192ab97a99cee2150))
* **fetch:** never hand on a truncated document, and let a body of exactly the cap through ([ba2b5bb](https://github.com/maxgfr/webindex/commit/ba2b5bb7ba3d7d5955759e3d9805cf50c6c38467))
* **mcp:** make the in-flight ceiling hold across concurrent stdio batches ([fb80f71](https://github.com/maxgfr/webindex/commit/fb80f712024f7874deccc89fc4ad686afce8fd5f))
* **rank:** stop hammingDistance silently dropping bits above 64 ([a200c19](https://github.com/maxgfr/webindex/commit/a200c1992af428f2400f15f64ae336bb7103e72f))

## [1.18.7](https://github.com/maxgfr/webindex/compare/v1.18.6...v1.18.7) (2026-09-02)


### Bug Fixes

* **cache:** write entries atomically, mkdir once per directory ([d2d3370](https://github.com/maxgfr/webindex/commit/d2d3370128d23b6e73760ff1067f946049c5f20a))
* **crawl:** read robots.txt per origin, fetch each depth as a concurrent wave ([fe6a3d7](https://github.com/maxgfr/webindex/commit/fe6a3d72fafe97403b65c01387f5ed6dfa95b287))
* **fetch:** cap httpJson responses like httpGet ([1105e5a](https://github.com/maxgfr/webindex/commit/1105e5ae26894f95345be59699a99a2724e4bcbf))
* **fetch:** download a content-type-only PDF or document once, not twice ([d46b486](https://github.com/maxgfr/webindex/commit/d46b486a0c1cfb1a325a946e5a11af8f03513184))
* **mcp:** keep a stdio batch under the in-flight ceiling ([38a78c6](https://github.com/maxgfr/webindex/commit/38a78c623a8c535c66f021e0d921116d4b2f251e))


### Performance Improvements

* **charset:** decode Windows-1252 in one native pass ([be4b8b6](https://github.com/maxgfr/webindex/commit/be4b8b66cd238f550ad4aef51a86333b519b5dd6))
* **pdf:** probe the OCR binaries once per process ([19ccacd](https://github.com/maxgfr/webindex/commit/19ccacd4f14421f29b592d0ac0cc3efa668f5e66))
* **rank:** hash simhash and fnv1a64 on 32-bit lanes, not BigInt ([d3d57f6](https://github.com/maxgfr/webindex/commit/d3d57f684419a9e1f3a8be836a45437946972776))
* **vector:** score each document once in hybridSearch, overlap the embed call ([8a53ed5](https://github.com/maxgfr/webindex/commit/8a53ed5ceed2a531ed27d00f26b8c693c3f95eb6))

## [1.18.6](https://github.com/maxgfr/webindex/compare/v1.18.5...v1.18.6) (2026-08-31)


### Bug Fixes

* cache service probes per endpoint ([43eb56c](https://github.com/maxgfr/webindex/commit/43eb56cfd8dee06a9926d9fda1521ae8ffcd0d05))

## [1.18.5](https://github.com/maxgfr/webindex/compare/v1.18.4...v1.18.5) (2026-08-31)


### Bug Fixes

* harden feed parsing and refresh toolchain ([1d34b49](https://github.com/maxgfr/webindex/commit/1d34b49760087ce0a1c9fdd295c84f196ef11ee7))

## [1.18.4](https://github.com/maxgfr/webindex/compare/v1.18.3...v1.18.4) (2026-08-25)


### Bug Fixes

* make webindex compatible with Codex ([66d5cd8](https://github.com/maxgfr/webindex/commit/66d5cd85e1ddfefe93538eb6009ed70d05648653))

## [1.18.3](https://github.com/maxgfr/webindex/compare/v1.18.2...v1.18.3) (2026-08-21)


### Bug Fixes

* **engines:** results decide — never call a page blocked when it parsed hits ([861dcbb](https://github.com/maxgfr/webindex/commit/861dcbb509112cbc23af2fe0ee3567418ca6e846))

## [1.18.2](https://github.com/maxgfr/webindex/compare/v1.18.1...v1.18.2) (2026-08-21)


### Bug Fixes

* **engines:** an engine that refuses to answer is not an empty web ([99fb4f9](https://github.com/maxgfr/webindex/commit/99fb4f919198c5bb8e25753f0308523bfe3bddaf))

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
* **cite:** the mechanics of reading citations, never the verdict ([9605ff9](https://github.com/maxgfr/webindex/commit/9605ff942c14454e9b6955d793aef84d11f69612))
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
