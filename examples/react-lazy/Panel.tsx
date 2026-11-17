import { useState } from "react";

export default function Panel() {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h2>Independent module</h2>
      <button onClick={() => setCount(count + 1)}>Panel count {count}</button>
    </section>
  );
}
