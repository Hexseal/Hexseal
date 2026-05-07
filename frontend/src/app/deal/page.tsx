import { redirect } from "next/navigation";

// /deal was the old "Post a Job" form.
// Canonical URL is now /board/client/post
export default function DealRedirect() {
  redirect("/board/client/post");
}
