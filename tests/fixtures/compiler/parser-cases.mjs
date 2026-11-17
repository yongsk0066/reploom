export function comparisons(count) {
  return `export const comparisons=[${Array(count).fill("a < b").join(",")}];`;
}

export function computedKeys(count) {
  return "a<{[".repeat(count) + "x" + "]:1}".repeat(count) + ";";
}

export function nestedGenerics(count) {
  return (
    "declare function f<T>(): T; export const value=f<" +
    "A<".repeat(count) +
    "T" +
    ">".repeat(count) +
    ">();"
  );
}

export const grammarCases = [
  "declare function f<T>(): T; const g = f<string>; export {g};",
  "const a=1,b=2,c=3; export const v=[a < b > c,a < b >= c,a < b > +c,a < b > -c];",
  "declare function f<T>(): T; export const v=f<{[(/>/).source]: string}>();",
  "declare function f<T>(): T; type T=string; export const v=f<`x${T}`>();",
  "const a=1,b=2; export const v=<div>{a < b}</div>;",
  "type X<U,T> = T extends infer U extends number ? U : T;",
  "type Y<U,T> = T extends (infer U extends number ? U : T) ? U : T;",
  "function* f(){return [a < b,a < b,a < b,a < b,a < b,a < {[yield x]: 1}];}",
  "async function f(){return [a < b,a < b,a < b,a < b,a < b,a < {[await x]: 1}];}",
  "declare function f<T>(): T; export const v=f<\n{a:string;b:number}\n>();",
  "declare function f<T>(): T; export const v=f<<T>()=>T>();",
  "declare function f<T>(): T; export const v=f<>();",
  "declare function f<T>(): T; export const v=f<{broken: >();",
];
