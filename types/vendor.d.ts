declare module 'pdfjs-dist' {
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(options: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
      }>;
    }>;
  };
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string;
  export default url;
}
