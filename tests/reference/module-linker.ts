import { parse, tokenizer } from "acorn";
import { analyze } from "eslint-scope";
import MagicString from "magic-string";
import type * as E from "estree";

// Oxc owns JSX/TS/Refresh. This pass owns our ABI: AST ranges and lexical
// references, never regex rewriting of import/export source.
type Located<T extends E.BaseNode = E.Node> = T & {
  start: number;
  end: number;
};

const located = <T extends E.BaseNode>(node: T) => node as Located<T>;

export function uniqueName(source: string, hint: string) {
  let name = `__playground_${hint}`;
  while (source.includes(name)) name += "_";
  return name;
}

export function linkModule(
  source: string,
  filename: string,
  refresh: { register: string; signature: string },
  budgeted = true,
) {
  const ast = parse(source, {
    ecmaVersion: 2022,
    sourceType: "module",
    ranges: true,
  }) as unknown as E.Program;

  const scopes = analyze(ast, {
    ecmaVersion: 2022,
    sourceType: "module",
    impliedStrict: true,
    ignoreEval: true,
  });

  const moduleScope = scopes.scopes.find((scope) => scope.type === "module")!;
  const text = new MagicString(source);
  const context = uniqueName(source, "module");
  const checkpoint = uniqueName(source, "checkpoint");
  const parents = new Map<E.Node, E.Node>();
  const nodes: E.Node[] = [];

  function visit(node: E.Node, parent?: E.Node) {
    // Only lexical replacements need parents; only ABI/budget operations need
    // a second pass. Data-heavy modules otherwise retain an extra Map entry and
    // array slot for every literal/property, plus Object.values arrays per node.
    if (
      parent &&
      node.type === "Identifier" &&
      (bindings.has(node.name) || node.name === "arguments")
    )
      parents.set(node, parent);
    switch (node.type) {
      // ESTree leaves have no child nodes. Data-heavy modules contain many of
      // them; do not inspect literal values, raw strings and location fields.
      case "Identifier":
      case "PrivateIdentifier":
      case "Literal":
      case "TemplateElement":
      case "ThisExpression":
      case "Super":
        return;
      case "ImportExpression":
      case "MetaProperty":
        nodes.push(node);
        break;
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "CatchClause":
        if (budgeted) nodes.push(node);
    }
    for (const key in node) {
      if (key === "range") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") visit(child, node);
      } else if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        typeof value.type === "string"
      )
        visit(value as E.Node, node);
    }
  }

  const imports = new Map<string, { name: string; names: Set<string> }>();
  const bindings = new Map<string, string>();
  const exports = new Map<string, string>();

  const stars: string[] = [];
  const dynamic: string[] = [];

  const removed: Array<[number, number]> = [];

  const remove = (node: E.Node) => {
    const { start, end } = located(node);
    removed.push([start, end]);
    text.remove(start, end);
  };

  const insideRemoved = (node: E.Node) =>
    removed.some(([a, b]) => located(node).start >= a && located(node).end <= b);

  const name = (node: E.Identifier | E.Literal) =>
    node.type === "Identifier" ? node.name : String(node.value);

  const dependency = (specifier: string) => {
    if (!imports.has(specifier))
      imports.set(specifier, {
        name: `${context}_import${imports.size}`,
        names: new Set(),
      });
    return imports.get(specifier)!;
  };

  for (const statement of ast.body) {
    if (statement.type === "ImportDeclaration") {
      if (
        "attributes" in statement &&
        Array.isArray(statement.attributes) &&
        statement.attributes.length
      )
        throw new Error("Import attributes are unsupported.");
      const dep = dependency(String(statement.source.value));
      for (const specifier of statement.specifiers) {
        const key =
          specifier.type === "ImportNamespaceSpecifier"
            ? undefined
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : name(specifier.imported);

        if (key !== undefined) dep.names.add(key);
        bindings.set(
          specifier.local.name,
          key === undefined ? dep.name : `${dep.name}[${JSON.stringify(key)}]`,
        );
      }
      remove(statement);
    } else if (statement.type === "ExportNamedDeclaration") {
      const decl = statement.declaration;
      if (decl) {
        text.remove(located(statement).start, located(decl).start);
        for (const variable of moduleScope.variables)
          if (
            variable.defs.some(
              (def) =>
                def.node === decl ||
                (decl.type === "VariableDeclaration" &&
                  decl.declarations.includes(def.node as E.VariableDeclarator)),
            )
          )
            exports.set(variable.name, variable.name);
      } else {
        const dep = statement.source ? dependency(String(statement.source.value)) : undefined;
        for (const specifier of statement.specifiers) {
          const local = name(specifier.local);
          if (dep) dep.names.add(local);
          exports.set(
            name(specifier.exported),
            dep ? `${dep.name}[${JSON.stringify(local)}]` : local,
          );
        }
        remove(statement);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const decl = statement.declaration;

      const local =
        (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id
          ? decl.id.name
          : `${context}_default`;

      exports.set("default", local);
      if (decl.type === "FunctionDeclaration") {
        text.remove(located(statement).start, located(decl).start);
        if (!decl.id) {
          const header = source.slice(located(decl).start, located(decl.body).start);
          const tokens = tokenizer(header, { ecmaVersion: 2022 });
          let token = tokens.getToken();
          while (token.type.label !== "(" && token.type.label !== "eof") token = tokens.getToken();
          text.appendLeft(located(decl).start + token.start, ` ${local} `);
        }
      } else if (decl.type === "ClassDeclaration" && decl.id)
        text.remove(located(statement).start, located(decl).start);
      else {
        text.overwrite(located(statement).start, located(decl).start, `const ${local} = (`);
        text.appendLeft(located(decl).end, ");");
      }
    } else if (statement.type === "ExportAllDeclaration") {
      const dep = dependency(String(statement.source.value));
      if (statement.exported) exports.set(name(statement.exported), dep.name);
      else stars.push(dep.name);
      remove(statement);
    }
  }
  visit(ast);
  for (const variable of moduleScope.variables) {
    const binding = bindings.get(variable.name);
    if (!binding) continue;
    for (const reference of variable.references) {
      const id = reference.identifier as E.Identifier;
      if (insideRemoved(id)) continue;
      if (reference.isWrite()) throw new Error(`Cannot assign to import binding: ${variable.name}`);
      const parent = parents.get(id);
      const value = `(0, ${binding})`; // Calls and tagged templates have undefined this.
      text.overwrite(
        located(id).start,
        located(id).end,
        parent?.type === "Property" && parent.shorthand ? `${variable.name}: ${value}` : value,
      );
    }
  }
  for (const node of nodes) {
    if (insideRemoved(node)) continue;
    if (node.type === "ImportExpression") {
      if (node.source.type !== "Literal" || typeof node.source.value !== "string")
        throw new Error("Dynamic imports require a string literal path.");
      if ("options" in node && node.options)
        throw new Error("Dynamic import options are unsupported.");
      dynamic.push(node.source.value);
      text.overwrite(located(node).start, located(node.source).start, `${context}.importDynamic(`);
    } else if (node.type === "MetaProperty" && node.meta.name === "import")
      text.overwrite(located(node).start, located(node).end, `${context}.meta`);
  }
  // Factories have an arguments object; ESM top levels (including arrows) do not.
  for (const reference of moduleScope.through) {
    const id = reference.identifier as E.Identifier;
    if (id.name !== "arguments" || insideRemoved(id)) continue;
    const parent = parents.get(id);
    if (parent?.type === "UnaryExpression" && parent.operator === "typeof")
      text.overwrite(
        located(parent).start,
        located(parent).end,
        `${context}.global("arguments", true)`,
      );
    else
      text.overwrite(
        located(id).start,
        located(id).end,
        `${parent?.type === "Property" && parent.shorthand ? "arguments: " : ""}${context}.global("arguments")`,
      );
  }
  // A dedicated compute Worker is terminated from outside its event loop.
  // Do not tax its hot loops with redundant cooperative checks.
  if (budgeted)
    for (const node of nodes) {
      if (insideRemoved(node)) continue;
      // Reuse this AST pass. No wrapping of functions, automatic async conversion,
      // or relocation of labeled loops: receiver/return/continue semantics stay
      // intact until an execution budget is exceeded.
      let guarded: E.Statement | E.Expression | undefined;
      if (
        [
          "WhileStatement",
          "DoWhileStatement",
          "ForStatement",
          "ForInStatement",
          "ForOfStatement",
        ].includes(node.type)
      )
        guarded = (node as E.WhileStatement).body;
      else if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      )
        guarded = node.body;
      else if (node.type === "CatchClause") guarded = node.body;
      if (guarded?.type === "BlockStatement") {
        let offset = located(guarded).start + 1;
        // Keep directive prologues first, including directives emitted by tools.
        for (const statement of guarded.body) {
          if (
            statement.type !== "ExpressionStatement" ||
            statement.expression.type !== "Literal" ||
            typeof statement.expression.value !== "string"
          )
            break;
          offset = located(statement).end;
        }
        text.appendLeft(offset, `;${checkpoint}();`);
      } else if (guarded) {
        const expression = node.type === "ArrowFunctionExpression";
        text.appendLeft(
          located(guarded).start,
          expression ? `(${checkpoint}(),` : `{${checkpoint}();`,
        );
        text.appendLeft(located(guarded).end, expression ? ")" : "}");
      }
    }

  const getters = [...exports].map(
    ([key, value]) =>
      `${context}.export(${JSON.stringify(key)}, () => ${bindings.get(value) || value});`,
  );

  const loads = [...imports].map(
    ([specifier, dep]) =>
      `const ${dep.name} = (await ${context}.importBindings(${JSON.stringify(specifier)}, ${JSON.stringify([...dep.names])}, true)).namespace;`,
  );

  text.prepend(
    `async function(${context}) {\n"use strict";\n${budgeted ? `const ${checkpoint} = ${context}.checkpoint;\n${checkpoint}();\n` : ""}const ${refresh.register} = ${context}.register, ${refresh.signature} = ${context}.signature;\n${getters.join("\n")}\n${loads.join("\n")}\n${stars.map((ns) => `${context}.exportAll(${ns});`).join("\n")}\n`,
  );
  text.append("\n}");
  return {
    code: text.toString(),
    // MagicString streams its encoded map; composition reads that stream without
    // retaining another decoded graph alongside the AST and final source map.
    map: text.generateMap({
      source: filename,
      includeContent: true,
      hires: "boundary",
    }),
    specifiers: [...imports.keys()],
    dynamic: [...new Set(dynamic)],
  };
}
