#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const server = new McpServer(
    {
        name: "apt-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

function ok(data) {
    return {
        success: true,
        content: data,
    };
}

function fail(err) {
    return {
        success: false,
        content:
            err?.stderr ||
            err?.message ||
            String(err),
    };
}

async function run(cmd, args = []) {
    return execFileAsync(cmd, args, {
        maxBuffer: 1024 * 1024 * 20,
    });
}

function text(obj) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(obj, null, 2),
            },
        ],
    };
}

server.tool(
    "apt.search",
    {
        query: z.string(),
    },
    async ({ query }) => {
        try {
            const { stdout } = await run("apt-cache", ["search", query]);

            const packages = stdout
                .split("\n")
                .filter(Boolean)
                .map(line => {
                    const idx = line.indexOf(" - ");

                    if (idx === -1) {
                        return {
                            package: line.trim(),
                            description: "",
                        };
                    }

                    return {
                        package: line.slice(0, idx).trim(),
                        description: line.slice(idx + 3).trim(),
                    };
                });

            return text(ok(packages));
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.info",
    {
        package: z.string(),
    },
    async ({ package: pkg }) => {
        try {
            const { stdout } = await run("apt-cache", ["show", pkg]);

            return text(
                ok({
                    package: pkg,
                    raw: stdout.trim(),
                })
            );
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.installed",
    {
        package: z.string().optional(),
    },
    async ({ package: pkg }) => {
        try {
            const args = ["-l"];

            if (pkg) {
                args.push(pkg);
            }

            const { stdout } = await run("dpkg", args);

            const lines = stdout
                .split("\n")
                .filter(l => l.startsWith("ii"));

            const packages = lines.map(line => {
                const parts = line.trim().split(/\s+/);

                return {
                    package: parts[1],
                    version: parts[2],
                    architecture: parts[3],
                };
            });

            return text(ok(packages));
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.install",
    {
        package: z.string(),
        assumeYes: z.boolean().default(true),
    },
    async ({ package: pkg, assumeYes }) => {
        try {
            const args = ["apt-get", "install"];

            if (assumeYes) {
                args.push("-y");
            }

            args.push(pkg);

            const { stdout, stderr } = await run("sudo", args);

            return text(
                ok({
                    package: pkg,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                })
            );
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.remove",
    {
        package: z.string(),
        purge: z.boolean().default(false),
        assumeYes: z.boolean().default(true),
    },
    async ({ package: pkg, purge, assumeYes }) => {
        try {
            const args = ["apt-get"];

            args.push(purge ? "purge" : "remove");

            if (assumeYes) {
                args.push("-y");
            }

            args.push(pkg);

            const { stdout, stderr } = await run("sudo", args);

            return text(
                ok({
                    package: pkg,
                    purge,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                })
            );
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.update",
    {},
    async () => {
        try {
            const { stdout, stderr } = await run("sudo", [
                "apt-get",
                "update",
            ]);

            return text(
                ok({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                })
            );
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.upgrade",
    {
        assumeYes: z.boolean().default(true),
    },
    async ({ assumeYes }) => {
        try {
            const args = ["apt-get", "upgrade"];

            if (assumeYes) {
                args.push("-y");
            }

            const { stdout, stderr } = await run("sudo", args);

            return text(
                ok({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                })
            );
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.autoremove",
    {
        assumeYes: z.boolean().default(true),
    },
    async ({ assumeYes }) => {
        try {
            const args = ["apt-get", "autoremove"];

            if (assumeYes) {
                args.push("-y");
            }

            const { stdout, stderr } = await run("sudo", args);

            return text(
                ok({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                })
            );
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.listUpgradable",
    {},
    async () => {
        try {
            const { stdout } = await run("apt", ["list", "--upgradable"]);

            const packages = stdout
                .split("\n")
                .slice(1)
                .filter(Boolean)
                .map(line => {
                    const [pkgPart, versionPart] = line.split(" upgradable from: ");

                    return {
                        package: pkgPart?.split("/")[0]?.trim(),
                        raw: line.trim(),
                        oldVersion: versionPart?.replace("]", "").trim(),
                    };
                });

            return text(ok(packages));
        } catch (e) {
            return text(fail(e));
        }
    }
);

server.tool(
    "apt.clean",
    {},
    async () => {
        try {
            const { stdout, stderr } = await run("sudo", [
                "apt-get",
                "clean",
            ]);

            return text(
                ok({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                })
            );
        } catch (e) {
            return text(fail(e));
        }
    }
);

const transport = new StdioServerTransport();

await server.connect(transport);
