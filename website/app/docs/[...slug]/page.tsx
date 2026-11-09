import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { MDXRemote } from 'next-mdx-remote/rsc'
import rehypePrettyCode from 'rehype-pretty-code'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { getDocBySlug, getAllDocSlugs } from '@/lib/mdx'
import DocsLayout from '@/components/DocsLayout'
import { Callout } from '@/components/Callout'
import { Pre } from '@/components/Pre'
import { codeThemes } from '@/lib/code-theme'
import { extractToc } from '@/lib/toc'

const components = {
  Note: (props: { children: React.ReactNode }) => <Callout type="note" {...props} />,
  Warning: (props: { children: React.ReactNode }) => <Callout type="warning" {...props} />,
  Flag: (props: { children: React.ReactNode }) => <Callout type="flag" {...props} />,
  pre: Pre,
}

export async function generateStaticParams() {
  return getAllDocSlugs().map(slug => ({ slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>
}): Promise<Metadata> {
  const { slug } = await params
  const doc = getDocBySlug(slug)
  if (!doc) return {}
  return {
    title: `${doc.frontmatter.title} — Motherbase Docs`,
    description: doc.frontmatter.description,
    openGraph: {
      title: doc.frontmatter.title,
      description: doc.frontmatter.description,
    },
  }
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string[] }>
}) {
  const { slug } = await params
  const doc = getDocBySlug(slug)
  if (!doc) notFound()

  const toc = extractToc(doc.rawContent)

  return (
    <DocsLayout
      toc={toc}
      href={'/docs/' + slug.join('/')}
      title={doc.frontmatter.title}
      description={doc.frontmatter.description}
    >
      <MDXRemote
        source={doc.rawContent}
        components={components}
        options={{
          mdxOptions: {
            remarkPlugins: [remarkGfm],
            rehypePlugins: [
              rehypeSlug,
              [rehypePrettyCode, { theme: codeThemes }] as any,
            ],
          },
        }}
      />
    </DocsLayout>
  )
}
