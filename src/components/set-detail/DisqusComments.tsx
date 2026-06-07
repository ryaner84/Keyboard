"use client";

import { DiscussionEmbed } from "disqus-react";

interface DisqusCommentsProps {
  slug: string;
  title: string;
  url: string;
}

export function DisqusComments({ slug, title, url }: DisqusCommentsProps) {
  const shortname = process.env.NEXT_PUBLIC_DISQUS_SHORTNAME;

  if (!shortname) return null;

  return (
    <div className="mt-10 pt-8 border-t border-gray-100">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">Community Discussion</h2>
      <DiscussionEmbed
        shortname={shortname}
        config={{
          url,
          identifier: `set-${slug}`,
          title,
        }}
      />
    </div>
  );
}
