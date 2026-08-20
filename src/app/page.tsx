import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold tracking-tight mb-4">
        Fighting Game Engine{' '}
        <span className="text-red-500">Web</span>
      </h1>
      <p className="text-zinc-400 text-center max-w-md mb-8">
        Browser-based MUGEN fighting game powered by IKEMEN GO v2 compiled to WebAssembly.
        Characters and stages served via CDN.
      </p>
      <Link
        href="/play"
        className="px-8 py-3 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg transition-colors text-lg"
      >
        Play Now
      </Link>
      <div className="mt-12 text-sm text-zinc-600">
        Engine: IKEMEN GO v2 (WASM) &middot; Assets: jsDelivr CDN
      </div>
    </div>
  );
}
