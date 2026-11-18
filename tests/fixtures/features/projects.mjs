export const projects = [
  {
    id: "react",
    title: "Revision React",
    runtime: "react",
    entry: "/App.tsx",
    checks: ["/check.ts"],
    files: {
      "/App.tsx": `import { Counter, label } from './Counter.tsx'; globalThis.parentLoads=(globalThis.parentLoads||0)+1; export default function App(){return <main><h1>{label}</h1><output>{globalThis.parentLoads}</output><Counter/></main>}`,
      "/Counter.tsx": `import { useState } from 'react'; const saved=import.meta.state('count',0); export const label='counter'; export function Counter(){const [count,setCount]=useState(saved.value); return <button onClick={()=>{saved.value++;setCount(saved.value)}}>count {count}</button>}`,
      "/check.ts": `export async function test({container,assert}){ await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); assert(container.querySelector('h1').textContent==='counter'); container.querySelector('button').click(); globalThis.testSideEffect=1; }`,
    },
  },
  {
    id: "dom",
    title: "Revision DOM",
    runtime: "dom",
    entry: "/main.ts",
    checks: ["/check.ts"],
    files: {
      "/main.ts": `import { label } from './label.ts'; const count=import.meta.state('count',0); export function mount(container,{signal}){const button=document.createElement('button'); const render=()=>button.textContent=label+' '+count.value; render(); button.addEventListener('click',()=>{count.value++;render()},{signal});container.replaceChildren(button);return()=>button.remove()}`,
      "/label.ts": "export const label: string = 'count';",
      "/check.ts": `import { label } from './label.ts'; export function test({container,assert}){ assert(label==='count'); container.querySelector('button').click(); assert(container.textContent==='count 1'); globalThis.testSideEffect=1; }`,
    },
  },
  {
    id: "compute",
    title: "Revision Compute",
    runtime: "compute",
    entry: "/main.ts",
    checks: ["/check.ts"],
    resources: { assets: { "/icon.svg": { url: "/dom-assets/icon.svg", type: "image/svg+xml" } } },
    files: {
      "/amount.txt": "10",
      "/identity.mts": "export const identity = <T,>(input: T) => input;",
      "/main.ts": `import amount from './amount.txt';
        import { identity } from './identity.mts';
        const count=import.meta.state('count',7);
        export const read=()=>count.value;
        export async function run(){
          const image=import.meta.resources.blob('/icon.svg');
          const text=await new Response(image.stream()).text();
          return { count: count.value, sum: identity(Number(amount)), svg: text.includes('<svg') };
        }`,
      "/check.ts": `import {read} from './main.ts'; export function test({assert}){assert(read()===7);}`,
    },
  },
];
