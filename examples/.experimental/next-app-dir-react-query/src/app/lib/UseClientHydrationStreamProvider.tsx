import { useServerInsertedHTML } from 'next/navigation';
import {
  Context,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

const serializedSymbol = Symbol('serialized');

interface DataTransformer {
  serialize(object: any): any;
  deserialize(object: any): any;
}

type Serialized<TData> = unknown & {
  [serializedSymbol]: TData;
};

interface TypedDataTransformer<TData> {
  serialize: (obj: TData) => Serialized<TData>;
  deserialize: (obj: Serialized<TData>) => TData;
}

interface HydrationStreamContext<TShape> {
  stream: {
    /**
     * Push a new entry to the stream
     * Only call this on the server
     */
    push: (...shape: TShape[]) => void;
  };
}

export function createDataStream<TShape>() {
  const context = createContext<HydrationStreamContext<TShape>>(null as any);
  /**
   *
   * Server:
   * 1. `useServerInsertedHTML()` is called **on the server** whenever a `Suspense`-boundary completes
   *    - This means that we might have some new entries in the cache that needs to be flushed
   *    - We pass these to the client by inserting a `<script>`-tag where we do `window.__stream[id].push(serializedVersionOfCache)`
   *
   * Client:
   * 2. In `useEffect()`:
   *   - We check if `window.__stream[id]` is set to an array and call `push()` on all the entries
   *   -
   **/
  function UseClientHydrationStreamProvider(props: {
    children: React.ReactNode;
    /**
     * Optional transformer to serialize/deserialize the data
     * Example devalue, superjson et al
     */
    transformer?: DataTransformer;
    /**
     * Called in the browser when new entries are received
     */
    onEntries: (entries: TShape[]) => void;
    /**
     * onDehydrate is called on the server when the cache is flushed
     */
    onFlush?: () => TShape[];
  }) {
    // unique id for the cache provider
    const id = useId();
    const [stream] = useState<TShape[]>(() => {
      if (typeof window !== 'undefined') {
        return {
          push() {
            // no-op on the client
          },
        } as unknown as TShape[];
      }
      return [];
    });

    const [transformer] = useState(
      () =>
        (props.transformer ?? {
          // noop
          serialize: (obj: any) => obj,
          deserialize: (obj: any) => obj,
        }) as unknown as TypedDataTransformer<TShape>,
    );
    const count = useRef(0);
    const onDehydrateRef = useRef(props.onFlush);
    onDehydrateRef.current = props.onFlush;

    // Server: flush cache
    useServerInsertedHTML(() => {
      console.log('flushing');
      if (typeof window !== 'undefined') {
        return null;
      }
      const _stream = [...stream, ...(onDehydrateRef.current?.() ?? [])];

      console.log('pushing', stream.length, 'entries');
      if (!_stream.length) {
        return null;
      }
      const serializedCacheArgs = _stream
        .map((entry) => transformer.serialize(entry))
        .map((entry) => JSON.stringify(entry))
        .join(',');

      // Flush stream
      stream.length = 0;

      // Calling:
      // window.__stream[id].push()
      console.log(
        'calling',
        `window.__stream["${id}"]`,
        'with',
        serializedCacheArgs,
      );
      return (
        <script
          key={count.current++}
          dangerouslySetInnerHTML={{
            __html: `
              window.__stream = window.__stream || {};
              window.__stream["${id}"] = window.__stream["${id}"] || [];
              window.__stream["${id}"].push(${serializedCacheArgs});
          `.trim(),
          }}
        />
      );
    });

    const onEntriesRef = useRef(props.onEntries);
    onEntriesRef.current = props.onEntries;

    // Client: consume cache:
    const push = useCallback(
      (...serializedCacheEntryRecord: Serialized<TShape>[]) => {
        const entries = serializedCacheEntryRecord.map((serialized) =>
          transformer.deserialize(serialized),
        );
        onEntriesRef.current(entries);
      },
      [transformer],
    );

    useEffect(() => {
      // Register cache consumer
      const win = window as any;
      win.__stream = win.__stream || {};

      win.__stream[id] = win.__stream[id] || [];
      const stream: Array<Serialized<TShape>> = win.__stream[id];

      if (!Array.isArray(win.__stream[id])) {
        throw new Error(`${id} seem to have been registered twice`);
      }
      push(...stream);

      // Register our own consumer
      win.__stream[id] = {
        push,
      };
    }, [id, push]);

    return (
      <context.Provider value={{ stream }}>{props.children}</context.Provider>
    );
  }

  return {
    Provider: UseClientHydrationStreamProvider,
    context,
  };
}