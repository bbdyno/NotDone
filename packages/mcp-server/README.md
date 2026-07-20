# NotDone MCP Server

`notdone-mcp` exposes
[NotDone](https://github.com/bbdyno/NotDone) verification through the Model
Context Protocol over stdio.

```sh
npm install --global notdone notdone-mcp
notdone-mcp
```

The server provides tools for capability discovery, task-contract validation,
proof verification, and proof-packet inspection. It restricts file operations
to the configured workspace root.
