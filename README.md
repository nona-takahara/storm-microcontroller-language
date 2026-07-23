# storm-microcontroller-language

[日本語版はこちら](README-ja.md)

A toolkit for converting Stormworks microcontroller save data (XML) to and from a human-editable DSL.

## Overview

The tool converts XML exported from Stormworks into text-based DSL files that can be edited in a text editor and tracked in Git. After editing, the DSL can be converted back to XML and re-imported into the game.

```
Stormworks XML  ──xml2dsl──▶  .sw-net / .sw-mcl / project.json
                ◀─dsl2xml──
```

## Setup

Node.js 18 or newer and pnpm are required.

```bash
pnpm install
```

## Usage

### XML to DSL (`xml2dsl`)

Convert a Stormworks-exported XML file into the DSL file set.

```bash
pnpm cli xml2dsl <input.xml> --out-dir <output-dir>
```

The output directory contains the following files.

| File | Contents |
|---|---|
| `main.sw-net` | Node definitions and wiring graph |
| `main.sw-mcl` | Layout data (instance/port positions) |
| `scripts/*.lua` | Lua script bodies |
| `project.json` | Metadata and node coordinates |

### DSL to XML (`dsl2xml`)

Convert an edited DSL project back into XML.

```bash
pnpm cli dsl2xml <project.json> --out <output.xml>
```

### Other commands

```bash
# Check DSL structure, such as unresolved references.
pnpm cli check-dsl <project.json>

# Type-check DSL signal compatibility between ports.
pnpm cli typecheck-dsl <project.json>

# Generate or validate .sw-mcl layout files.
pnpm cli layout-dsl <project.json> [--all-submodules] [--force] [--dry-run] [--grid-size <n>]

# Query gate specs and tool behavior. With no arguments, this prints tool conventions and Stormworks system notes.
pnpm cli spec
pnpm cli spec --list                 # List all gate IDs
pnpm cli spec SR_LATCH                # Show ports, properties, and known behavior notes for one gate
pnpm cli spec SR_LATCH --json         # Print machine-readable JSON
```

The `spec` command helps both humans and AI agents understand gate and tool behavior without reading the source code. It combines port/property structure with known in-game behavior from `src/node-behavior-notes.json` and `src/stormworks-system-notes.json`, including confidence levels for unverified notes.

## MCP server

The package also exposes a stdio MCP server for agent clients.

```bash
pnpm mcp
# after installation/build:
storm-mcl-mcp
```

Available MCP tools mirror the core CLI workflows.

| Tool | Purpose |
|---|---|
| `xml_to_dsl` | Convert a Stormworks XML file into `project.json`, `.sw-net`, and `.sw-mcl` files. |
| `dsl_to_xml` | Convert a DSL project back into Stormworks XML, optionally writing it to a path. |
| `check_dsl` | Validate DSL syntax and import resolution. |
| `typecheck_dsl` | Validate signal types and report port mismatches. |
| `spec` | Read the same gate/tool behavior reference as `storm-mcl spec`; use `list=true`, `gate_id`, and/or `json=true`. |
| `layout_dsl` | Compute (and by default write) `.sw-mcl` auto-layout, same as `storm-mcl layout-dsl`; supports `module_id`/`document_path`, `all_submodules`, `force`, `dry_run`, and `grid_size`. |

All MCP tool descriptions and responses are written in English so global MCP clients can display them consistently.

## DSL format

### `.sw-net`

`.sw-net` describes node instances and wiring.

```
# Import another .sw-net file at the top of the file.
import pid from "./pid.sw-net"

module main
  port in "Speed Input" : number
  port in "Active"      : boolean
  port out "Throttle"   : number

  # Place gates with inst, then wire inputs to outputs with the : ... -> ... form.
  inst CLAMP n1 (min=0, max=1) : value="Speed Input" -> out="Throttle"
  inst AND   n2 : a="Active", b=n1_out -> out=n2_out

  # Embed another module as a submodule with use.
  use pid.controller ctrl : input=n1_out -> output="Throttle"
end
```

**Basic syntax:**

- `port in / out` — external module ports, corresponding to Stormworks input/output nodes
- `inst <definitionId> <instanceName>` — place a gate
- `(key=value)` — gate properties
- `: <input> -> <output>` — wiring, using port names or net names
- `# ...` — line comments, either at the start of a line or after content

**Submodules:**

Use `use` to embed a module defined in another `.sw-net` file.

```
# Import at the top of the file, in the form alias from "path".
import lib from "./lib.sw-net"

module main
  # use <alias>.<moduleId> <instanceName> : input -> output
  use lib.myModule sub1 : input=someNet -> output=resultNet
end
```

Modules in the same file can be referenced without an alias.

```
module helper
  port in "x" : number
  port out "y" : number
  inst ADD a : a="x", b="x" -> out="y"
end

module main
  port out "result" : number
  use helper h : x=someValue -> y="result"
end
```

### Main definition IDs

| Category | Example IDs |
|---|---|
| Logic | `NOT` `AND` `OR` `XOR` `NAND` `NOR` `TOGGLE` `PULSE` |
| Flip-flops | `SR_LATCH` `JK_FF` |
| Logic functions | `BOOL_FUNC_4` `BOOL_FUNC_8` |
| Arithmetic | `ADD` `SUBTRACT` `MULTIPLY` `DIVIDE` |
| Numeric operations | `ABS` `CLAMP` `DELTA` `MODULO` `EQUAL` |
| Functions | `FUNC_NUM_1` `FUNC_NUM_3` `FUNC_NUM_8` |
| Comparisons | `GREATER_THAN` `LESS_THAN` `THRESHOLD` |
| Control | `PID` `PID_ADVANCED` `TIMER_TON` `TIMER_TOF` `TIMER_RTF` `TIMER_RTO` `COUNTER` |
| Other control | `MEMORY_REGISTER` `BLINKER` `CAPACITOR` `NUM_JUNCTION` `NUM_SWITCHBOX` |
| Composite | `COMPOSITE_READ_NUMBER` `COMPOSITE_READ_BOOLEAN` `COMPOSITE_WRITE_NUMBER` `COMPOSITE_WRITE_BOOLEAN` `COMPOSITE_SWITCHBOX` `COMPOSITE_TO_NUMBER` `NUMBER_TO_COMPOSITE` |
| Video and audio | `VIDEO_SWITCHBOX` `AUDIO_SWITCHBOX` |
| Lua | `LUA` |
| Constants | `CONST` `CONST_BOOL` |
| Properties | `PROPERTY_NUMBER` `PROPERTY_SLIDER` `PROPERTY_TOGGLE` `PROPERTY_TEXT` `PROPERTY_DROPDOWN` |
| Debug | `TOOLTIP_NUMBER` `TOOLTIP_BOOLEAN` |

### `.sw-mcl`

`.sw-mcl` stores layout data (instance/port positions) only. `LUA` nodes' script bodies live in `.sw-net`'s `script_ref` attribute, which resolves to a `scripts/*.lua` sidecar file -- `.sw-mcl` never references scripts. It is usually generated automatically.

### `project.json`

`project.json` stores metadata such as the microcontroller name, size, and node coordinates.
