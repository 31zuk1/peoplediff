/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingExcludes: {
    "*": [
      "./*.md",
      "./output/**/*",
      "./data/snapshots/**/*.json",
      "./data/snapshots/index*.json",
      "./data/snapshots/latest*.json"
    ]
  }
};

export default nextConfig;
