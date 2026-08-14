/*
 * Forge: Play Magic: the Gathering.
 * Copyright (C) 2011  Forge Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package forge.util.collect;

import java.util.AbstractCollection;
import java.util.Collection;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.function.Predicate;
import java.util.stream.Stream;

/** A truly unmodifiable facade for an {@link FCollectionView}. */
final class UnmodifiableFCollectionView<T> extends AbstractCollection<T>
        implements FCollectionView<T> {
    private final FCollectionView<T> delegate;

    UnmodifiableFCollectionView(final FCollectionView<T> delegate0) {
        delegate = delegate0;
    }

    @Override
    public int size() {
        return delegate.size();
    }

    @Override
    public boolean isEmpty() {
        return delegate.isEmpty();
    }

    @Override
    public boolean contains(final Object object) {
        return delegate.contains(object);
    }

    @Override
    public boolean containsAll(final Collection<?> collection) {
        return delegate.containsAll(collection);
    }

    @Override
    public Iterator<T> iterator() {
        final Iterator<T> iterator = delegate.iterator();
        return new Iterator<T>() {
            @Override
            public boolean hasNext() {
                return iterator.hasNext();
            }

            @Override
            public T next() {
                return iterator.next();
            }

            @Override
            public void remove() {
                throw new UnsupportedOperationException();
            }
        };
    }

    @Override
    public Object[] toArray() {
        return delegate.toArray();
    }

    @Override
    public <E> E[] toArray(final E[] array) {
        return delegate.toArray(array);
    }

    @Override
    public T get(final int index) {
        return delegate.get(index);
    }

    @Override
    public T getFirst() {
        return delegate.getFirst();
    }

    @Override
    public T getLast() {
        return delegate.getLast();
    }

    @Override
    public int indexOf(final Object object) {
        return delegate.indexOf(object);
    }

    @Override
    public int lastIndexOf(final Object object) {
        return delegate.lastIndexOf(object);
    }

    @Override
    public List<T> subList(final int fromIndex, final int toIndex) {
        return Collections.unmodifiableList(delegate.subList(fromIndex, toIndex));
    }

    @Override
    public Iterable<T> threadSafeIterable() {
        return delegate.threadSafeIterable();
    }

    @Override
    public T get(final T object) {
        return delegate.get(object);
    }

    @Override
    public Stream<T> stream() {
        return delegate.stream();
    }

    @Override
    public boolean anyMatch(final Predicate<? super T> test) {
        return delegate.anyMatch(test);
    }

    @Override
    public boolean allMatch(final Predicate<? super T> test) {
        return delegate.allMatch(test);
    }

    @Override
    public boolean add(final T element) {
        throw new UnsupportedOperationException();
    }

    @Override
    public boolean remove(final Object object) {
        throw new UnsupportedOperationException();
    }

    @Override
    public boolean addAll(final Collection<? extends T> collection) {
        throw new UnsupportedOperationException();
    }

    @Override
    public boolean removeAll(final Collection<?> collection) {
        throw new UnsupportedOperationException();
    }

    @Override
    public boolean retainAll(final Collection<?> collection) {
        throw new UnsupportedOperationException();
    }

    @Override
    public boolean removeIf(final Predicate<? super T> filter) {
        throw new UnsupportedOperationException();
    }

    @Override
    public void clear() {
        throw new UnsupportedOperationException();
    }

    @Override
    public boolean equals(final Object object) {
        if (object == this) {
            return true;
        }
        if (object instanceof UnmodifiableFCollectionView<?>) {
            return delegate.equals(((UnmodifiableFCollectionView<?>) object).delegate);
        }
        return false;
    }

    @Override
    public int hashCode() {
        return delegate.hashCode();
    }

    @Override
    public String toString() {
        return delegate.toString();
    }
}
