"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cached = cached;
/**
 * Cache the result of a function on an object
 *
 * We could have used @decorators to make this nicer but we don't use them anywhere yet,
 * so let's keep it simple and readable.
 */
function cached(obj, sym, fn) {
    if (!(sym in obj)) {
        obj[sym] = fn();
    }
    return obj[sym];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FjaGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2FjaGVkLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBTUEsd0JBS0M7QUFYRDs7Ozs7R0FLRztBQUNILFNBQWdCLE1BQU0sQ0FBc0IsR0FBTSxFQUFFLEdBQVcsRUFBRSxFQUFXO0lBQzFFLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2pCLEdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQztJQUMzQixDQUFDO0lBQ0QsT0FBUSxHQUFXLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0IsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2FjaGUgdGhlIHJlc3VsdCBvZiBhIGZ1bmN0aW9uIG9uIGFuIG9iamVjdFxuICpcbiAqIFdlIGNvdWxkIGhhdmUgdXNlZCBAZGVjb3JhdG9ycyB0byBtYWtlIHRoaXMgbmljZXIgYnV0IHdlIGRvbid0IHVzZSB0aGVtIGFueXdoZXJlIHlldCxcbiAqIHNvIGxldCdzIGtlZXAgaXQgc2ltcGxlIGFuZCByZWFkYWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhY2hlZDxBIGV4dGVuZHMgb2JqZWN0LCBCPihvYmo6IEEsIHN5bTogc3ltYm9sLCBmbjogKCkgPT4gQik6IEIge1xuICBpZiAoIShzeW0gaW4gb2JqKSkge1xuICAgIChvYmogYXMgYW55KVtzeW1dID0gZm4oKTtcbiAgfVxuICByZXR1cm4gKG9iaiBhcyBhbnkpW3N5bV07XG59XG4iXX0=