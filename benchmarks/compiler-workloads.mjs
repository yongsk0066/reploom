export const compilerWorkloads = {
  small: [
    "/counter.tsx",
    "react",
    "import {useState} from 'react'; export default function Counter(){const [n,setN]=useState(0); return <button onClick={()=>setN(n+1)}>{n}</button>}",
  ],
  functions: [
    "/large.ts",
    "dom",
    Array.from(
      { length: 10000 },
      (_, i) => `export function f${i}(a: number) { return a + ${i}; }`,
    ).join("\n"),
  ],
  jsx: [
    "/large.tsx",
    "react",
    "import {useState} from 'react';\n" +
      Array.from(
        { length: 2000 },
        (_, i) =>
          `export function C${i}() { const [n,setN]=useState(0); return <button onClick={()=>setN(n+1)}>한글😀 {n}</button> }`,
      ).join("\n"),
  ],
  bindings: [
    "/large.ts",
    "dom",
    Array.from(
      { length: 4000 },
      (_, i) =>
        `import {x as x${i}} from './dep.ts'; export function f${i}(){ const {a,b} = x${i}; return [a,b,x${i}]; }`,
    ).join("\n"),
  ],
};
