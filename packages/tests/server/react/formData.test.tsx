import { routerToServerAndClientNew } from '../___testHelpers';
import { createQueryClient } from '../__queryClient';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  experimental_formDataLink,
  httpBatchLink,
  loggerLink,
  splitLink,
} from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { CreateTRPCReactBase } from '@trpc/react-query/createTRPCReact';
import { initTRPC } from '@trpc/server';
import { konn } from 'konn';
import React, { ReactNode } from 'react';
import SuperJSON from 'superjson';
import { z } from 'zod';
import { zfd } from 'zod-form-data';

beforeAll(async () => {
  const { FormData, File, Blob } = await import('node-fetch');
  globalThis.FormData = FormData;
  globalThis.File = File;
  globalThis.Blob = Blob;
});

function formDataOrObject<T extends z.ZodRawShape>(input: T) {
  return zfd.formData(input).or(z.object(input));
}

const ctx = konn()
  .beforeEach(() => {
    // We construct a complete t instance to ensure that customised t's work fine
    const t = initTRPC
      .meta<{ foo: number }>()
      .context<{ randomKey?: string }>()
      .create({
        errorFormatter: (a) => {
          return {
            ...a.shape,
            foo: 1,
          };
        },
        transformer: SuperJSON,
        defaultMeta: { foo: 1 },
      });

    const appRouter = t.router({
      polymorphic: t.procedure

        .input(
          formDataOrObject({
            text: z.string(),
          }),
        )
        .mutation((opts) => {
          return opts.input;
        }),
      uploadFile: t.procedure

        .input(
          zfd.formData({
            file: zfd.file(),
          }),
        )
        .mutation(async ({ input }) => {
          return {
            file: {
              name: input.file.name,
              type: input.file.type,
              file: await input.file.text(),
            },
          };
        }),
      passthroughFile: t.procedure
        .input((formData: any) => formData as FormData)
        .mutation(async ({ input }) => {
          if (input instanceof FormData) {
            return Array.from(input.keys());
          } else {
            throw new Error('Unknown input: ' + String(input));
          }
        }),
    });

    type TRouter = typeof appRouter;

    const loggerLinkConsole = {
      log: vi.fn(),
      error: vi.fn(),
    };
    const opts = routerToServerAndClientNew(appRouter, {
      server: {
        createContext() {
          return {
            // Don't need to attach req or res for this
          };
        },
      },
      client: ({ httpUrl }) => ({
        links: [
          loggerLink({
            enabled: () => true,
            // console: loggerLinkConsole,
          }),
          splitLink({
            condition: (op) => op.input instanceof FormData,
            true: experimental_formDataLink({
              url: httpUrl,
            }),
            false: httpBatchLink({
              url: httpUrl,
            }),
          }),
        ],
      }),
    });

    const queryClient = createQueryClient();
    const proxy = createTRPCReact<TRouter, unknown, 'ExperimentalSuspense'>();
    const baseProxy = proxy as CreateTRPCReactBase<TRouter, unknown>;

    const client = opts.client;

    function App(props: { children: ReactNode }) {
      return (
        <baseProxy.Provider {...{ queryClient, client }}>
          <QueryClientProvider client={queryClient}>
            {props.children}
          </QueryClientProvider>
        </baseProxy.Provider>
      );
    }

    return {
      ...opts,
      close: opts.close,
      queryClient,
      App,
      loggerLinkConsole,
    };
  })
  .afterEach(async (ctx) => {
    await ctx?.close?.();
  })
  .done();

test('upload file', async () => {
  const form = new FormData();
  form.append(
    'file',
    new File(['hi bob'], 'bob.txt', {
      type: 'text/plain',
    }),
  );

  const fileContents = await ctx.proxy.uploadFile.mutate(form);

  expect(fileContents).toMatchInlineSnapshot(`
    Object {
      "file": Object {
        "file": "hi bob",
        "name": "bob.txt",
        "type": "text/plain",
      },
    }
  `);
});

test('polymorphic - accept both JSON and FormData', async () => {
  const form = new FormData();
  form.set('text', 'foo');

  const formDataRes = await ctx.proxy.polymorphic.mutate(form);
  const jsonRes = await ctx.proxy.polymorphic.mutate({
    text: 'foo',
  });
  expect(formDataRes).toEqual(jsonRes);
});

test('polymorphic - createCaller', async () => {
  const form = new FormData();
  form.set('text', 'foo');

  const caller = ctx.router.createCaller({});
  const formDataRes = await caller.polymorphic(form);
  const jsonRes = await ctx.proxy.polymorphic.mutate({
    text: 'foo',
  });
  expect(formDataRes).toEqual(jsonRes);
});

test("passthrough, don't validate/parse the input beyond loading the formData", async () => {
  const form = new FormData();
  form.set('text', 'foo');

  const formDataRes = await ctx.proxy.passthroughFile.mutate(form);

  expect(formDataRes).toEqual(['text']);
});
