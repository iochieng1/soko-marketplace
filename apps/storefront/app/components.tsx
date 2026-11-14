import type { ReactNode } from "react";

export function ErrorState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800"
    >
      <h1 className="font-semibold">{title}</h1>
      <p className="mt-1 text-sm">
        {children ??
          "The shop is having trouble right now. Please try again in a moment."}
      </p>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 p-10 text-center text-stone-500">
      {children}
    </div>
  );
}
