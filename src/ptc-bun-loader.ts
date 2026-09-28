/** Bun adaptations for the official PTC process runtime, without a second runtime implementation. */
import { plugin } from "bun"
import { readFileSync } from "node:fs"
import { basename } from "node:path"

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) {
    throw new Error("The official PTC runtime changed; review its Bun adaptation before upgrading")
  }
  return source.replace(before, () => after)
}

plugin({
  name: "dsh-ptc-runtime-bun",
  setup(build) {
    build.onLoad({ filter: /[/\\]@deepseek-ai[/\\]dsh-ptc-runtime-node[/\\]lib[/\\](index|process)\.js$/ }, args => {
      let source = readFileSync(args.path, "utf8")
      if (basename(args.path) === "index.js") {
        source = replaceOnce(source, 'import { stripTypeScriptTypes } from "node:module";\n',
          'import { transformSync } from "amaro";\nfunction stripTypeScriptTypes(source) { return transformSync(source).code; }\n')
      } else {
        source = replaceOnce(source, 'import { Socket } from "node:net";',
          'import { createReadStream, createWriteStream, closeSync } from "node:fs";\nimport { Duplex } from "node:stream";')
        source = replaceOnce(source, '\treturn new Socket({\n\t\tfd: 7,\n\t\treadable: true,\n\t\twritable: true,\n\t\tallowHalfOpen: true\n\t});',
          '\tconst channel = Duplex.from({\n\t\treadable: createReadStream(null, { fd: 7, autoClose: false }),\n\t\twritable: createWriteStream(null, { fd: 7, autoClose: false })\n\t});\n\tchannel.once("close", () => closeSync(7));\n\treturn channel;')
      }
      return { contents: source, loader: "js" }
    })
  },
})

