"""The one exception the build reports without a traceback."""


class InputError(ValueError):
    """A problem in the editors' inputs or in the project file.

    The message names the file, the line or key, and what to change, because
    the people who fix it are editors, not developers.
    """
