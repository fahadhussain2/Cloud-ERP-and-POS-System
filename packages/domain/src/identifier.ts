// The search key of an item identifier (data model §4, CAT-02): upper case, without spaces, dashes, slashes and dots.
// One rule for the importer, the counter's search and the back office, so a part number typed any way finds the
// number as stored.
export const normalizeIdentifier = (value: string): string => value.toUpperCase().replace(/[\s\-/.]/g, '');
