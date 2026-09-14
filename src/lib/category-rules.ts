interface CategorizedEvent {
  title: string;
  description?: string;
  categoryIds: string[];
}

/** Apply deterministic category rules shared by collectors and the site build. */
export function applyAutomaticCategoryRules<T extends CategorizedEvent>(event: T): T {
  if (!/koncert/iu.test(`${event.title}\n${event.description ?? ""}`)) return event;

  const categoryIds = event.categoryIds.filter((categoryId) => categoryId !== "andet");
  if (!categoryIds.includes("musik-kultur")) categoryIds.push("musik-kultur");
  return { ...event, categoryIds };
}
